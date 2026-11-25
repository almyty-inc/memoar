//! When the app captures on its own, and how it says so.
//!
//! Kept apart from the window so the rules can be tested without one.

use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::failure::Failure;

/// How often the app captures on its own.
///
/// Two minutes: often enough that an ongoing session is archived while it is
/// still going, rare enough that a laptop is not scanning constantly.
pub const INTERVAL: Duration = Duration::from_secs(120);

/// What decides whether a capture may run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Gate {
    pub signed_in: bool,
    /// The person paused automatic capture.
    pub paused: bool,
    /// A capture is already running.
    pub busy: bool,
}

/// What the capture loop is doing, as the window names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Capturing,
    Busy,
    Paused,
    /// The archive refused this machine and nothing runs until a new sign-in.
    Stopped,
    SignedOut,
}

fn stopped(last_error: Option<&Failure>) -> bool {
    last_error.is_some_and(Failure::stops_capture)
}

#[must_use]
pub fn mode(gate: Gate, last_error: Option<&Failure>) -> Mode {
    if !gate.signed_in {
        Mode::SignedOut
    } else if stopped(last_error) {
        Mode::Stopped
    } else if gate.busy {
        Mode::Busy
    } else if gate.paused {
        Mode::Paused
    } else {
        Mode::Capturing
    }
}

/// Whether the timer's capture runs now.
#[must_use]
pub fn automatic(gate: Gate, last_error: Option<&Failure>) -> bool {
    mode(gate, last_error) == Mode::Capturing
}

/// Whether "Capture now" can be pressed. Pausing stops the timer, not the
/// person, so a paused machine can still capture on request.
#[must_use]
pub fn manual(gate: Gate, last_error: Option<&Failure>) -> bool {
    matches!(mode(gate, last_error), Mode::Capturing | Mode::Paused)
}

#[must_use]
pub fn caption(mode: Mode) -> &'static str {
    match mode {
        Mode::Capturing => "Capturing every two minutes.",
        Mode::Busy => "Capturing now.",
        Mode::Paused => "Paused. Nothing is captured until you resume.",
        Mode::Stopped => "Capture has stopped.",
        Mode::SignedOut => "Not signed in.",
    }
}

fn plural(count: i64, unit: &str) -> String {
    if count == 1 {
        format!("1 {unit} ago")
    } else {
        format!("{count} {unit}s ago")
    }
}

/// How long ago an RFC 3339 time was, in words.
#[must_use]
pub fn ago(then: &str, now: DateTime<Utc>) -> String {
    let Ok(then) = DateTime::parse_from_rfc3339(then) else {
        return then.to_owned();
    };
    let seconds = (now - then.with_timezone(&Utc)).num_seconds();
    match seconds {
        ..60 => "just now".to_owned(),
        60..3_600 => plural(seconds / 60, "minute"),
        3_600..86_400 => plural(seconds / 3_600, "hour"),
        _ => plural(seconds / 86_400, "day"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::FailureKind;

    const SIGNED_IN: Gate = Gate {
        signed_in: true,
        paused: false,
        busy: false,
    };

    fn failure(kind: FailureKind) -> Failure {
        Failure::new(kind, "message", "detail")
    }

    #[test]
    fn captures_on_the_timer_only_when_nothing_holds_it() {
        assert!(automatic(SIGNED_IN, None));
        assert!(automatic(
            SIGNED_IN,
            Some(&failure(FailureKind::Unreachable))
        ));
        assert!(!automatic(
            Gate {
                paused: true,
                ..SIGNED_IN
            },
            None
        ));
        assert!(!automatic(
            Gate {
                busy: true,
                ..SIGNED_IN
            },
            None
        ));
        assert!(!automatic(Gate::default(), None));
    }

    #[test]
    fn a_revoked_machine_is_not_retried_by_the_timer_or_the_button() {
        let revoked = failure(FailureKind::Revoked);

        assert_eq!(mode(SIGNED_IN, Some(&revoked)), Mode::Stopped);
        assert!(!automatic(SIGNED_IN, Some(&revoked)));
        assert!(!manual(SIGNED_IN, Some(&revoked)));
    }

    #[test]
    fn pausing_stops_the_timer_and_leaves_the_button() {
        let paused = Gate {
            paused: true,
            ..SIGNED_IN
        };

        assert_eq!(mode(paused, None), Mode::Paused);
        assert!(manual(paused, None));
        assert!(!manual(
            Gate {
                busy: true,
                ..SIGNED_IN
            },
            None
        ));
    }

    #[test]
    fn every_mode_reads_differently() {
        let modes = [
            Mode::Capturing,
            Mode::Busy,
            Mode::Paused,
            Mode::Stopped,
            Mode::SignedOut,
        ];
        let mut captions: Vec<_> = modes.iter().map(|mode| caption(*mode)).collect();
        captions.sort_unstable();
        captions.dedup();
        assert_eq!(captions.len(), modes.len());
    }

    #[test]
    fn says_how_long_ago_in_words() {
        let now = DateTime::parse_from_rfc3339("2026-09-04T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        assert_eq!(ago("2026-09-04T11:59:30Z", now), "just now");
        assert_eq!(ago("2026-09-04T11:59:00Z", now), "1 minute ago");
        assert_eq!(ago("2026-09-04T11:30:00Z", now), "30 minutes ago");
        assert_eq!(ago("2026-09-04T09:00:00Z", now), "3 hours ago");
        assert_eq!(ago("2026-09-02T12:00:00Z", now), "2 days ago");
        assert_eq!(ago("not a time", now), "not a time");
    }
}
