//! Local capture, immutable offline queueing, optional redaction, and delta sync.

pub mod memory;

mod artifact;
mod attempts;
mod capture;
mod enqueue;
mod error;
mod manifest;
mod queue;
mod redaction;
mod sync;
mod transport;
mod watcher;

#[cfg(test)]
mod tests;

// `memory.rs` reaches for this at the crate root, where it used to live.
pub(crate) use crate::artifact::redact_artifact;
pub use crate::attempts::MAX_ATTEMPTS;
pub use crate::capture::{CaptureSummary, capture_sources, capture_sources_with_redaction};
pub use crate::enqueue::sha256_bytes;
pub use crate::error::DaemonError;
pub use crate::manifest::{IngestManifest, IngestReceipt, ManifestArtifact, SyncTransport};
pub use crate::queue::{OfflineQueue, QueueCounts, QueueStatus, QueuedArtifact};
pub use crate::redaction::RedactionConfig;
pub use crate::sync::{SyncEngine, SyncReport};
pub use crate::transport::{
    HttpTransport, MAX_ARTIFACT_BYTES, SLOWEST_TOLERATED_UPLOAD_BYTES_PER_SEC, TokenMinter,
    UPLOAD_TIMEOUT,
};
pub use crate::watcher::{DebouncedChanges, FileFingerprint, PollingCapture};
