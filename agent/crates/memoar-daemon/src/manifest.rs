//! The ingest wire types and the transport contract the sync engine works through.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::error::DaemonError;
use crate::queue::QueuedArtifact;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestArtifact {
    pub sha256: String,
    pub size: u64,
    pub source: String,
    pub source_path: String,
    pub modified_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestManifest {
    pub machine_id: String,
    pub batch_id: String,
    pub artifacts: Vec<ManifestArtifact>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestReceipt {
    pub batch_id: String,
    pub accepted: u64,
    pub duplicate: u64,
    pub queued_at: String,
}

pub trait SyncTransport {
    fn missing(&self, machine_id: &str, hashes: &[String]) -> Result<HashSet<String>, DaemonError>;
    fn upload(&self, artifact: &QueuedArtifact, bytes: Vec<u8>) -> Result<(), DaemonError>;
    fn submit_manifest(&self, manifest: &IngestManifest) -> Result<IngestReceipt, DaemonError>;
}
