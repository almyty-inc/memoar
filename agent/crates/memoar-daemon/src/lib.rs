//! Local capture, the offline queue, optional redaction, and delta sync.

pub mod memory;

mod activity;
mod artifact;
mod attempts;
mod blobs;
mod capture;
mod declare;
mod enqueue;
mod error;
mod header_path;
mod held;
mod manifest;
mod patient;
mod plan;
mod policy;
mod progress;
mod queue;
mod redaction;
mod secret_catalogue;
mod settle;
mod source_bytes;
mod space;
mod sync;
mod transport;
mod upload;
mod watcher;
mod workspace;

#[cfg(test)]
mod tests;

// `memory.rs` reaches for this at the crate root, where it used to live.
pub use crate::activity::QueueActivity;
pub(crate) use crate::artifact::redact_artifact;
pub use crate::attempts::MAX_ATTEMPTS;
pub use crate::blobs::PruneReport;
pub use crate::capture::{
    CaptureSummary, Tally, capture_sources, capture_sources_with_policy,
    capture_sources_with_redaction,
};
pub use crate::enqueue::sha256_bytes;
pub use crate::error::DaemonError;
pub use crate::held::PolicyApplied;
pub use crate::manifest::{IngestManifest, IngestReceipt, ManifestArtifact, SyncTransport};
pub use crate::plan::{
    CapturePlan, PlanCounts, ProjectPlan, SourcePlan, UNKNOWN_WORKSPACE, plan_capture,
};
pub use crate::policy::{CapturePolicy, Verdict, parse_since, workspace_matches};
pub use crate::progress::Progress;
pub use crate::queue::{OfflineQueue, QueueCounts, QueueStatus, QueuedArtifact};
pub use crate::redaction::RedactionConfig;
pub use crate::space::{SpaceCheck, SpaceFloor, check_space, ensure_space};
pub use crate::sync::{SyncEngine, SyncReport};
pub use crate::transport::{
    HttpTransport, MAX_ARTIFACT_BYTES, SLOWEST_TOLERATED_UPLOAD_BYTES_PER_SEC, TokenMinter,
    UPLOAD_TIMEOUT,
};
pub use crate::watcher::{DebouncedChanges, FileFingerprint, PollingCapture, ScanSources};
pub use crate::workspace::WorkspaceResolver;
