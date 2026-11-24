//! What gets masked, and the byte-level scan that masks it.

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::secret_catalogue::COMPILED_CATALOGUE;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionConfig {
    pub secrets: bool,
    pub email_addresses: bool,
    pub home_paths: bool,
}

impl RedactionConfig {
    #[must_use]
    pub const fn disabled() -> Self {
        Self {
            secrets: false,
            email_addresses: false,
            home_paths: false,
        }
    }

    #[must_use]
    pub const fn enabled(self) -> bool {
        self.secrets || self.email_addresses || self.home_paths
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RedactedBytes {
    /// False when the bytes could not be read as text, so no pattern was applied.
    pub(crate) scanned: bool,
    pub(crate) bytes: Vec<u8>,
    pub(crate) replacements: u32,
}

pub(crate) fn redact_bytes(bytes: &[u8], config: RedactionConfig) -> RedactedBytes {
    if !config.enabled() {
        return RedactedBytes {
            bytes: bytes.to_vec(),
            replacements: 0,
            scanned: true,
        };
    }
    let Ok(mut text) = String::from_utf8(bytes.to_vec()) else {
        // Not text we can rewrite. Returning the bytes untouched here is what
        // the caller must not do silently: see redact_artifact, which scans a
        // lossy view and refuses the artifact if anything matches.
        return RedactedBytes {
            bytes: bytes.to_vec(),
            replacements: 0,
            scanned: false,
        };
    };
    let mut replacements = 0_u32;
    if config.secrets {
        // The catalogue is shared with the archive's scanner and held to the
        // same fixture, so the two halves agree on what a credential looks
        // like. See secret_catalogue.rs.
        replacements = mask_secrets(&mut text);
    }
    let mut apply = |pattern: &str, replacement: &str| {
        let regex = Regex::new(pattern).expect("static redaction pattern must compile");
        let matches = regex.find_iter(&text).count() as u32;
        if matches > 0 {
            text = regex.replace_all(&text, replacement).into_owned();
            replacements = replacements.saturating_add(matches);
        }
    };
    if config.email_addresses {
        apply(
            r"\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
            "[REDACTED_EMAIL]",
        );
    }
    if config.home_paths {
        // Backslash excluded for the same reason as the secret rules above: a
        // path inside a JSON-encoded string is followed by `\"`, and eating the
        // backslash leaves a quote that closes the string. This is why captured
        // transcripts read `/home/[REDACTED_USER]/obt` and then stopped parsing.
        apply(r#"/(?:Users|home)/[^/\s\"'\\]+"#, "/home/[REDACTED_USER]");
        apply(
            r#"(?i)[A-Z]:\\Users\\[^\\\s\"']+"#,
            "C:\\Users\\[REDACTED_USER]",
        );
    }
    RedactedBytes {
        bytes: text.into_bytes(),
        replacements,
        scanned: true,
    }
}

/// Whether a lossy reading of non-UTF-8 bytes trips any enabled pattern.
///
/// Used only to decide whether to refuse an artifact, never to rewrite one:
/// replacing text in a lossy view and writing it back would mangle every byte
/// that did not survive the conversion.
pub(crate) fn contains_secret_lossy(bytes: &[u8], config: RedactionConfig) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let probe = redact_bytes(text.as_bytes(), config);
    probe.replacements > 0
}

/// The same question asked of text stored two bytes to the character.
///
/// UTF-16 is the hole `contains_secret_lossy` does not cover. ASCII encoded as
/// UTF-16 is *valid UTF-8* — every other byte is a NUL, and a NUL is a legal
/// code point — so `redact_bytes` reports the artifact scanned, the patterns
/// find nothing because every character is separated by a NUL, and the
/// fail-closed check never runs because it only fires on bytes that are not
/// UTF-8 at all. A key in a UTF-16 log went up verbatim under a receipt saying
/// it had been scanned.
///
/// Only the ASCII range is decoded, because that is all a secret pattern
/// matches, and this is a detector rather than a decoder: the answer feeds a
/// refusal, never a rewrite.
pub(crate) fn contains_secret_utf16(bytes: &[u8], config: RedactionConfig) -> bool {
    [true, false].into_iter().any(|little_endian| {
        let decoded: String = bytes
            .chunks_exact(2)
            .map(|pair| {
                let unit = if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                };
                if unit < 128 { unit as u8 as char } else { ' ' }
            })
            .collect();
        redact_bytes(decoded.as_bytes(), config).replacements > 0
    })
}

/// Whether these bytes are plausibly text stored two bytes to the character.
///
/// A byte-order mark settles it. Without one, a NUL is the tell: real UTF-8
/// text does not contain them, and UTF-16 ASCII is half NULs.
pub(crate) fn looks_like_utf16(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return true;
    }
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.len() < 4 {
        return false;
    }
    let nuls = sample.iter().filter(|byte| **byte == 0).count();
    nuls * 4 >= sample.len()
}

/// Masks every rule's matches in order, and returns how many were masked.
///
/// A rule with a group named `secret` masks only that group and leaves the rest
/// of its match, such as the key in `password=…`, in place.
pub(crate) fn mask_secrets(text: &mut String) -> u32 {
    let mut replacements = 0_u32;
    for compiled in COMPILED_CATALOGUE.iter() {
        let mut output = String::with_capacity(text.len());
        let mut last = 0;
        let mut found = 0_u32;
        for captures in compiled.regex.captures_iter(text) {
            let whole = captures.get(0).expect("group 0 always participates");
            let secret = captures.name("secret").unwrap_or(whole);
            output.push_str(&text[last..secret.start()]);
            output.push_str(compiled.rule.kind.marker());
            output.push_str(&text[secret.end()..whole.end()]);
            last = whole.end();
            found = found.saturating_add(1);
        }
        if found > 0 {
            output.push_str(&text[last..]);
            *text = output;
            replacements = replacements.saturating_add(found);
        }
    }
    replacements
}
