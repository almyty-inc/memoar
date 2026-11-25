//! Everything this daemon refuses to do, and which refusals a pass survives.

use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DaemonError {
    #[error("queue database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("artifact I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("source discovery failed: {0}")]
    Discovery(#[from] memoar_connectors::DiscoveryError),
    #[error("sync transport failed: {0}")]
    Transport(String),
    /// The connection itself could not be made: no route, refused, DNS, or the
    /// connect timeout. Nothing was sent, so nothing about the artifact is
    /// implicated.
    #[error("the archive could not be reached: {0}")]
    Unreachable(String),
    /// The archive answered, and the answer was not a success.
    #[error("HTTP {status}: {}", problem_detail(.body))]
    Http { status: u16, body: String },
    #[error("server returned an invalid response: {0}")]
    Protocol(String),
    #[error(
        "{path} is not valid UTF-8 and matched a redaction pattern, so it cannot be rewritten safely"
    )]
    UnscannableSecret { path: PathBuf },
    #[error("client redaction is unsupported for opaque artifact {0}")]
    UnsupportedRedaction(PathBuf),
    #[error("ZIP redaction failed for {path}: {message}")]
    Zip { path: PathBuf, message: String },
    #[error("{path} is {size} bytes, past the {limit}-byte ceiling the archive accepts")]
    TooLarge {
        path: PathBuf,
        size: u64,
        limit: u64,
    },
    /// Writing would take the volume below the free-space floor.
    #[error(
        "{path} is on a volume with {available} bytes free, and capture keeps at least {floor} bytes free{}",
        if *needed > 0 { format!(" (this write needs {needed} more)") } else { String::new() }
    )]
    DiskLow {
        path: PathBuf,
        available: u64,
        floor: u64,
        needed: u64,
    },
}

impl DaemonError {
    /// Redaction was asked for and cannot be applied to this artifact.
    ///
    /// Three variants mean the same thing to a caller: the file stays on the
    /// machine. They are named in one place because handling two of the three
    /// is how a Zed write-ahead log went on aborting the whole capture after
    /// the other two had been fixed.
    pub fn is_unredactable(&self) -> bool {
        matches!(
            self,
            DaemonError::UnscannableSecret { .. }
                | DaemonError::UnsupportedRedaction(_)
                | DaemonError::Zip { .. }
        )
    }

    /// This artifact is not going anywhere, and that must not cost the caller
    /// every other artifact in the pass.
    ///
    /// Redaction is one reason a file stays behind; being larger than the
    /// archive will accept is another, and the capture loop has to treat them
    /// alike. Handling only the redaction half is how a Zed write-ahead log
    /// used to end a whole sweep, and a 500 MB stray file would do it again
    /// through the other door.
    pub fn is_skippable(&self) -> bool {
        self.is_unredactable() || matches!(self, DaemonError::TooLarge { .. })
    }

    /// The whole pass is stopped by this, not just the artifact that drew it.
    ///
    /// An archive that cannot be reached, will not take this machine's
    /// credential, or is overloaded refuses the next artifact exactly as it
    /// refused this one. Treating that as the artifact's fault cost every
    /// artifact in the batch an attempt, and a request each: 256 connection
    /// timeouts of 20 seconds on a dead network is an hour and a half spent
    /// learning one fact. Eight such outages abandoned the artifact for good.
    pub fn is_pass_wide(&self) -> bool {
        match self {
            DaemonError::Unreachable(_) => true,
            DaemonError::Http { status, .. } => {
                matches!(status, 401 | 403 | 408 | 429 | 502 | 503 | 504)
            }
            _ => false,
        }
    }
}

/// The sentence in a problem document, or the start of a body that is not one.
///
/// The queue's `last_error` held the whole RFC 9457 document, and a proxy's
/// HTML error page in full, which nobody reading `status` wants.
fn problem_detail(body: &str) -> String {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
    let field = |name: &str| {
        parsed
            .as_ref()
            .and_then(|problem| problem.get(name))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    field("detail")
        .or_else(|| field("title"))
        .unwrap_or_else(|| body.trim().chars().take(200).collect())
}
