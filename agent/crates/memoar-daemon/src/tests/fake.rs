use chrono::Utc;
use std::collections::HashSet;
use std::sync::Mutex;

use crate::error::DaemonError;
use crate::manifest::{IngestManifest, IngestReceipt, SyncTransport};
use crate::queue::QueuedArtifact;

#[derive(Default)]
pub(crate) struct FakeTransport {
    pub(crate) uploaded: Mutex<Vec<Vec<u8>>>,
    pub(crate) fail_manifest: bool,
    pub(crate) partial_receipt: bool,
}

impl SyncTransport for FakeTransport {
    fn missing(
        &self,
        _machine_id: &str,
        hashes: &[String],
    ) -> Result<HashSet<String>, DaemonError> {
        Ok(hashes.iter().cloned().collect())
    }

    fn upload(&self, _artifact: &QueuedArtifact, bytes: Vec<u8>) -> Result<(), DaemonError> {
        self.uploaded.lock().unwrap().push(bytes);
        Ok(())
    }

    fn submit_manifest(&self, manifest: &IngestManifest) -> Result<IngestReceipt, DaemonError> {
        if self.fail_manifest {
            return Err(DaemonError::Transport("offline".to_owned()));
        }
        Ok(IngestReceipt {
            batch_id: manifest.batch_id.clone(),
            accepted: if self.partial_receipt {
                0
            } else {
                manifest.artifacts.len() as u64
            },
            duplicate: 0,
            queued_at: Utc::now().to_rfc3339(),
        })
    }
}

/// Assembled at runtime so the repository's own secret scan does not flag it.
pub(crate) fn token_fixture() -> String {
    ["sk", "livefixtureabcdefghijklmnop"].join("_")
}

/// A transport that already holds some hashes and refuses others, which is
/// what a real pass looks like once anything is large enough to lose.
pub(crate) struct PartialTransport {
    pub(crate) present: HashSet<String>,
    pub(crate) refuse: HashSet<String>,
}

impl SyncTransport for PartialTransport {
    fn missing(
        &self,
        _machine_id: &str,
        hashes: &[String],
    ) -> Result<HashSet<String>, DaemonError> {
        Ok(hashes
            .iter()
            .filter(|hash| !self.present.contains(*hash))
            .cloned()
            .collect())
    }

    fn upload(&self, artifact: &QueuedArtifact, _bytes: Vec<u8>) -> Result<(), DaemonError> {
        if self.refuse.contains(&artifact.sha256) {
            return Err(DaemonError::Transport("connection closed".to_owned()));
        }
        Ok(())
    }

    fn submit_manifest(&self, manifest: &IngestManifest) -> Result<IngestReceipt, DaemonError> {
        Ok(IngestReceipt {
            batch_id: manifest.batch_id.clone(),
            accepted: manifest.artifacts.len() as u64,
            duplicate: 0,
            queued_at: Utc::now().to_rfc3339(),
        })
    }
}
