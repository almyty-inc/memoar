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
}
