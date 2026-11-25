//! What went wrong, sorted by what the window should do about it.
//!
//! The CLI reports every failure to talk to the archive as one network error
//! whose message ends in `(HTTP <status>)` when the archive answered at all.
//! That is right for a script, which retries or does not. A window has to say
//! more: an archive that is down will come back, a password that is wrong will
//! not start working, and a machine whose key was revoked must stop asking.

use memoar_cli::AppError;
use serde::{Deserialize, Serialize};

/// The kinds of failure the window treats differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    /// No answer: a refused connection, a name that does not resolve, a
    /// timeout. Retried on the next cycle.
    Unreachable,
    /// The archive refused the credentials given at sign-in.
    Rejected,
    /// The archive no longer accepts this machine: its key was revoked or the
    /// machine was removed. Automatic capture stops until somebody signs in.
    Revoked,
    /// This machine has no credential any more, for example after
    /// `memoar login` elsewhere failed half way or the file was removed.
    SignedOut,
    /// A failure that should pass: a busy archive, a rate limit, another
    /// capture holding the queue. Retried on the next cycle.
    Temporary,
    /// Anything else, shown as the CLI worded it.
    Other,
}

/// A failure as the window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub kind: FailureKind,
    /// One sentence for the person in front of the window.
    pub message: String,
    /// What the CLI said, kept for diagnosis.
    pub detail: String,
}

impl Failure {
    #[must_use]
    pub fn new(kind: FailureKind, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            detail: detail.into(),
        }
    }

    /// Whether automatic capture must stop rather than try again.
    ///
    /// Retrying a revoked credential every two minutes changes nothing on this
    /// machine and fills the archive's audit log with refusals.
    #[must_use]
    pub fn stops_capture(&self) -> bool {
        matches!(self.kind, FailureKind::Revoked | FailureKind::SignedOut)
    }
}

/// The HTTP status the archive answered with, when it answered.
#[must_use]
pub fn http_status(message: &str) -> Option<u16> {
    let start = message.rfind("(HTTP ")? + "(HTTP ".len();
    let rest = &message[start..];
    let end = rest.find(')')?;
    rest[..end].trim().parse().ok()
}

fn unreachable(endpoint: &str, detail: &str) -> Failure {
    Failure::new(
        FailureKind::Unreachable,
        format!(
            "Cannot reach the archive at {endpoint}. Check the address and that the server is running."
        ),
        detail,
    )
}

/// Classifies a failed `memoar login`.
#[must_use]
pub fn classify_sign_in(error: &AppError, endpoint: &str) -> Failure {
    let detail = error.message.as_str();
    match (error.code.as_str(), http_status(detail)) {
        ("MEMOAR_USAGE", _) => Failure::new(FailureKind::Other, detail, detail),
        (_, Some(401)) => Failure::new(
            FailureKind::Rejected,
            "The archive did not accept these credentials. Check them and try again.",
            detail,
        ),
        (_, Some(403)) => Failure::new(
            FailureKind::Rejected,
            "These credentials are not allowed to register a machine.",
            detail,
        ),
        (_, Some(404)) => Failure::new(
            FailureKind::Other,
            "The address answered, but not as a Memoar archive. It usually ends in /v1.",
            detail,
        ),
        (_, Some(status)) => server_trouble(status, detail),
        ("MEMOAR_NETWORK" | "MEMOAR_TIMEOUT", None) => unreachable(endpoint, detail),
        _ => Failure::new(FailureKind::Other, detail, detail),
    }
}

/// Classifies a failed capture.
#[must_use]
pub fn classify_capture(error: &AppError, endpoint: &str) -> Failure {
    let detail = error.message.as_str();
    match (error.code.as_str(), http_status(detail)) {
        ("MEMOAR_NOT_INITIALIZED", _) => Failure::new(
            FailureKind::SignedOut,
            "This machine is not signed in. Sign in to start capturing.",
            detail,
        ),
        ("MEMOAR_LOCKED", _) => Failure::new(
            FailureKind::Temporary,
            "Another capture is using this machine's queue. The next one will run as usual.",
            detail,
        ),
        (_, Some(401 | 403)) => Failure::new(
            FailureKind::Revoked,
            "The archive no longer accepts this machine's key. Capture has stopped. Sign in again to resume.",
            detail,
        ),
        (_, Some(404)) => Failure::new(
            FailureKind::Revoked,
            "The archive no longer has this machine. Capture has stopped. Sign in again to register it.",
            detail,
        ),
        (_, Some(status)) => server_trouble(status, detail),
        ("MEMOAR_NETWORK" | "MEMOAR_TIMEOUT", None) => unreachable(endpoint, detail),
        _ => Failure::new(FailureKind::Other, detail, detail),
    }
}

fn server_trouble(status: u16, detail: &str) -> Failure {
    let kind = if status == 429 || status >= 500 {
        FailureKind::Temporary
    } else {
        FailureKind::Other
    };
    let message = if kind == FailureKind::Temporary {
        format!("The archive is having trouble (HTTP {status}). The next capture will try again.")
    } else {
        detail.to_owned()
    };
    Failure::new(kind, message, detail)
}

#[cfg(test)]
#[path = "failure_tests.rs"]
mod tests;
