//! The capture agent's half of the scanner parity check.
//!
//! The archive runs the same corpus against the same catalogue in
//! `server/test/secret-catalogue.test.ts`. Both must produce the `masked` text
//! and the `count` the fixture records, so they agree with each other by
//! agreeing with it. Before this, an `AKIA…` key went up unredacted under
//! `--redact-secrets`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;

use crate::redaction::{RedactionConfig, redact_bytes};
use crate::secret_catalogue::{COMPILED_CATALOGUE, SECRET_CATALOGUE};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../server/test/fixtures/secret-scanner")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{name}: {error}"))
}

/// Joined at run time, so no file in the repository spells a credential out.
fn text_of(parts: &Value) -> String {
    let mut text = String::new();
    for part in parts.as_array().expect("parts is a list") {
        match part {
            Value::String(piece) => text.push_str(piece),
            _ => {
                let piece = part["repeat"]
                    .as_str()
                    .expect("a repeat part names a string");
                let times = part["times"]
                    .as_u64()
                    .expect("a repeat part says how often");
                text.push_str(&piece.repeat(usize::try_from(times).unwrap()));
            }
        }
    }
    text
}

fn secrets_only() -> RedactionConfig {
    RedactionConfig {
        secrets: true,
        ..RedactionConfig::disabled()
    }
}

#[test]
fn the_catalogue_is_the_table_the_fixture_describes() {
    let catalogue = fixture("catalogue.json");
    let rules = catalogue["rules"].as_array().expect("rules is a list");
    assert_eq!(rules.len(), SECRET_CATALOGUE.len(), "rule count");
    for (rule, expected) in SECRET_CATALOGUE.iter().zip(rules) {
        assert_eq!(rule.id, expected["id"], "rules are in the fixture's order");
        assert_eq!(rule.kind.name(), expected["kind"], "{}: kind", rule.id);
        assert_eq!(
            rule.case_insensitive, expected["caseInsensitive"],
            "{}: case",
            rule.id
        );
        assert_eq!(rule.pattern, expected["pattern"], "{}: pattern", rule.id);
    }
}

#[test]
fn every_rule_compiles() {
    assert_eq!(COMPILED_CATALOGUE.len(), SECRET_CATALOGUE.len());
}

#[test]
fn both_sides_mask_the_shared_corpus_the_same_way() {
    let corpus = fixture("corpus.json");
    let budget = Duration::from_millis(corpus["budgetMs"].as_u64().unwrap());
    // Debug builds of the regex crate run several times slower than release.
    // The bound is about shape, linear or not, so it scales with the build.
    let budget = if cfg!(debug_assertions) {
        budget * 4
    } else {
        budget
    };
    let marker = Regex::new(r"\[REDACTED[^\]]*\]").unwrap();
    // Compile outside the timed section.
    assert!(!COMPILED_CATALOGUE.is_empty());

    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let text = text_of(&case["parts"]);
        let json = case["json"].as_bool().unwrap_or(false);
        if json {
            serde_json::from_str::<Value>(&text)
                .unwrap_or_else(|error| panic!("{name}: the fixture must start as JSON: {error}"));
        }

        let started = Instant::now();
        let redacted = redact_bytes(text.as_bytes(), secrets_only());
        let elapsed = started.elapsed();

        assert!(redacted.scanned, "{name}: text must be scanned");
        let out = String::from_utf8(redacted.bytes).unwrap();
        let expected = case["masked"].as_str().unwrap_or(&text);
        let normalized = marker.replace_all(&out, "[REDACTED]");
        assert!(
            normalized == expected,
            "{name}: masked differently from the archive\n  got: {}\n want: {}",
            truncated(&normalized),
            truncated(expected),
        );
        assert_eq!(
            u64::from(redacted.replacements),
            case["count"].as_u64().unwrap(),
            "{name}: count"
        );
        assert!(
            elapsed < budget,
            "{name}: took {elapsed:?}, which is a rule walking the input"
        );
        if json {
            serde_json::from_str::<Value>(&out)
                .unwrap_or_else(|error| panic!("{name}: redaction broke the JSON: {error}"));
        }
    }
}

fn truncated(text: &str) -> String {
    text.chars().take(400).collect()
}
