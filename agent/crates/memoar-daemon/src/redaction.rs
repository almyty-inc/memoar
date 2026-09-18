//! What gets masked, and the byte-level scan that masks it.

use regex::Regex;
use serde::{Deserialize, Serialize};

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
    let mut apply = |pattern: &str, replacement: &str| {
        let regex = Regex::new(pattern).expect("static redaction pattern must compile");
        let matches = regex.find_iter(&text).count() as u32;
        if matches > 0 {
            text = regex.replace_all(&text, replacement).into_owned();
            replacements = replacements.saturating_add(matches);
        }
    };
    if config.secrets {
        apply(
            r"(?is)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
            "[REDACTED_PRIVATE_KEY]",
        );
        apply(
            r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
            "[REDACTED_JWT]",
        );
        // The key/value shape as people actually write it, rather than as it
        // appears in a shell one-liner.
        //
        // The old pattern anchored the key name with `\b` and excluded quotes
        // from the value, so it caught `api_key=abc` and almost nothing else on
        // a real machine: `"api_key": "sk-live-..."` never matched, because the
        // value group could not start on a quote; `export OPENAI_API_KEY="..."`
        // and `AWS_SECRET_ACCESS_KEY=...` never matched, because `\b` does not
        // fire between `_` and a letter. JSONL is the primary format of several
        // capture sources, so the quoted form is the ordinary one — and the
        // artifact was then filed as `redacted: false, redaction_count: 0`,
        // which is the worst available outcome: a secret uploaded under a
        // receipt saying there was nothing to find.
        //
        // So the key name may carry a prefix and a suffix, and the separator
        // may carry the quote on either side. The value stops before the
        // closing quote, which is left where it was, so `"k": "v"` comes out as
        // well-formed JSON.
        apply(
            r#"(?i)([A-Za-z0-9_.-]{0,40}(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)[A-Za-z0-9_.-]{0,40})(["']?[ \t]*[:=][ \t]*["']?)([^\s"',;{}\[\]]+)"#,
            "${1}${2}[REDACTED]",
        );
        // `Authorization: Bearer abcdef123456`, and the header's JSON form.
        //
        // Anchored on the header name rather than on the word `Bearer`: a bare
        // scheme word is ordinary English, and redacting whatever follows
        // "bearer" or "basic" would eat its way through prose. Anchored the
        // other way round, the scheme word has to be stepped over explicitly or
        // the credential survives with only `Bearer` removed.
        apply(
            r#"(?i)((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)((?:bearer|basic|token)[ \t]+)?([^\s"',;{}\[\]]+)"#,
            "${1}${2}[REDACTED]",
        );
        apply(
            r"\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b",
            "[REDACTED_TOKEN]",
        );
    }
    if config.email_addresses {
        apply(
            r"\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
            "[REDACTED_EMAIL]",
        );
    }
    if config.home_paths {
        apply(r#"/(?:Users|home)/[^/\s\"']+"#, "/home/[REDACTED_USER]");
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
