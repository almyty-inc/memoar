//! How the status screen words its values.
//!
//! An absent value reads as absent ("Not yet"), never as a zero, so a machine
//! that has not captured does not look like one that captured nothing.

use chrono::{DateTime, Utc};

use crate::schedule::ago;

/// `1 session`, `3 sessions`, or `Not yet` when nothing was measured.
#[must_use]
pub fn count(value: Option<u64>, unit: &str) -> String {
    match value {
        None => "Not yet".to_owned(),
        Some(1) => format!("1 {unit}"),
        Some(value) => format!("{value} {unit}s"),
    }
}

/// What is still in the queue, saying apart what the archive turned away.
#[must_use]
pub fn waiting(queued: Option<u64>, retrying: Option<u64>) -> String {
    match (queued.unwrap_or(0), retrying.unwrap_or(0)) {
        (0, 0) => "Nothing".to_owned(),
        (queued, 0) => count(Some(queued), "artifact"),
        (queued, retrying) => format!("{}, {retrying} to retry", count(Some(queued), "artifact")),
    }
}

#[must_use]
pub fn sources(names: &[String]) -> String {
    if names.is_empty() {
        "None found".to_owned()
    } else {
        names.join(", ")
    }
}

#[must_use]
pub fn last_capture(at: Option<&str>, now: DateTime<Utc>) -> String {
    at.map_or_else(|| "Not yet".to_owned(), |at| ago(at, now))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_measured_is_not_a_zero() {
        assert_eq!(count(None, "session"), "Not yet");
        assert_eq!(count(Some(0), "session"), "0 sessions");
        assert_eq!(count(Some(1), "session"), "1 session");
        assert_eq!(count(Some(4), "session"), "4 sessions");
    }

    #[test]
    fn the_queue_says_what_is_left() {
        assert_eq!(waiting(None, None), "Nothing");
        assert_eq!(waiting(Some(0), Some(0)), "Nothing");
        assert_eq!(waiting(Some(3), Some(0)), "3 artifacts");
        assert_eq!(waiting(Some(1), Some(2)), "1 artifact, 2 to retry");
    }

    #[test]
    fn sources_are_named() {
        assert_eq!(sources(&[]), "None found");
        assert_eq!(
            sources(&["Claude Code".to_owned(), "Codex".to_owned()]),
            "Claude Code, Codex"
        );
    }

    #[test]
    fn a_machine_that_never_captured_says_so() {
        let now = Utc::now();
        assert_eq!(last_capture(None, now), "Not yet");
        assert_eq!(last_capture(Some(&now.to_rfc3339()), now), "just now");
    }
}
