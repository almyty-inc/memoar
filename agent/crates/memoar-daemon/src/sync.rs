//! The delta sync pass: ask what is missing, upload it, then declare the batch.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use uuid::Uuid;

use crate::enqueue::sha256_bytes;
use crate::error::DaemonError;
use crate::manifest::{IngestManifest, ManifestArtifact, SyncTransport};
use crate::queue::{OfflineQueue, QueuedArtifact};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub batch_id: Option<String>,
    pub considered: usize,
    pub uploaded: usize,
    pub duplicates: usize,
    /// Artifacts the server would not take. They stay queued for the next run.
    pub failed: usize,
}

pub struct SyncEngine<T> {
    transport: T,
    batch_limit: usize,
}

impl<T: SyncTransport> SyncEngine<T> {
    #[must_use]
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            batch_limit: 256,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_batch_limit(transport: T, batch_limit: usize) -> Self {
        Self {
            transport,
            batch_limit,
        }
    }

    /// Passes until the queue has nothing left that is due.
    ///
    /// One pass takes at most `batch_limit` artifacts, and `memoar sync` ran
    /// one pass: a first sync on a machine with 1,000 sessions uploaded 256
    /// and reported success, and the rest waited for somebody to run it
    /// three more times. A pass that fills its batch is followed by another.
    /// It ends because every artifact a pass offered is either synced or
    /// waiting out a backoff, so the next pass never offers it again.
    pub fn drain(&self, queue: &OfflineQueue, machine_id: &str) -> Result<SyncReport, DaemonError> {
        let mut total = self.sync(queue, machine_id)?;
        let mut last = total.clone();
        // A ceiling as well, so a queue that misbehaves cannot spin a sync
        // for ever: 4,096 passes is a million artifacts.
        let mut passes = 1;
        while last.considered >= self.batch_limit && passes < 4096 {
            passes += 1;
            last = self.sync(queue, machine_id)?;
            total.considered += last.considered;
            total.uploaded += last.uploaded;
            total.duplicates += last.duplicates;
            total.failed += last.failed;
            total.batch_id = last.batch_id.clone().or(total.batch_id);
        }
        Ok(total)
    }
    #[cfg(test)]
    pub(crate) fn transport(&self) -> &T {
        &self.transport
    }
    pub fn sync(&self, queue: &OfflineQueue, machine_id: &str) -> Result<SyncReport, DaemonError> {
        let artifacts = queue.pending(self.batch_limit)?;
        if artifacts.is_empty() {
            return Ok(SyncReport {
                batch_id: None,
                considered: 0,
                uploaded: 0,
                failed: 0,
                duplicates: 0,
            });
        }
        let hashes: Vec<_> = artifacts
            .iter()
            .map(|artifact| artifact.sha256.clone())
            .collect();
        let missing = match self.transport.missing(machine_id, &hashes) {
            Ok(missing) => missing,
            Err(error) => {
                record_failure(queue, &artifacts, &error)?;
                return Err(error);
            }
        };
        let mut uploaded = 0;
        let mut failed = 0;
        // Counted, not derived. This was `considered - uploaded`, which quietly
        // reported every failed upload as a duplicate: a pass that lost seven
        // large transcripts to a dead connection printed "duplicates: 7" and
        // looked like a pass with nothing to do.
        let mut duplicates = 0;
        // Hashes the server does not have and this pass could not give it. The
        // manifest must not name them: it is a claim that these bytes are in
        // the archive, and the server checks.
        let mut absent: HashSet<String> = HashSet::new();
        for (index, artifact) in artifacts.iter().enumerate() {
            if !missing.contains(&artifact.sha256) {
                duplicates += 1;
                continue;
            }
            // One artifact the server will not take must not block the rest.
            //
            // Every branch here already recorded the artifact for retry and
            // then returned, so a single transcript the ingress rejected — a
            // 110 MB session against a 64 MB body limit — stopped every other
            // upload in the batch. The queue remembers; the loop carries on.
            let bytes = match fs::read(&artifact.local_path) {
                Ok(bytes) => bytes,
                Err(source) => {
                    let error = DaemonError::Io {
                        path: artifact.local_path.clone(),
                        source,
                    };
                    queue.mark_retry(
                        &artifact.sha256,
                        &artifact.source_path,
                        &error.to_string(),
                    )?;
                    absent.insert(artifact.sha256.clone());
                    failed += 1;
                    continue;
                }
            };
            if sha256_bytes(&bytes) != artifact.sha256 {
                let error = DaemonError::Protocol(format!(
                    "queued blob {} failed SHA-256 verification",
                    artifact.sha256
                ));
                queue.mark_retry(&artifact.sha256, &artifact.source_path, &error.to_string())?;
                absent.insert(artifact.sha256.clone());
                failed += 1;
                continue;
            }
            if let Err(error) = self.transport.upload(artifact, bytes) {
                if error.is_pass_wide() {
                    // Nothing after this one will get through either. What
                    // was uploaded already is in the archive by its hash, so
                    // the next pass finds it there and declares it then.
                    let untried: Vec<QueuedArtifact> = artifacts[index..]
                        .iter()
                        .filter(|later| missing.contains(&later.sha256))
                        .cloned()
                        .collect();
                    queue.mark_deferred(&untried, &error.to_string())?;
                    return Err(error);
                }
                queue.mark_retry(&artifact.sha256, &artifact.source_path, &error.to_string())?;
                absent.insert(artifact.sha256.clone());
                failed += 1;
                continue;
            }
            uploaded += 1;
        }
        let batch_id = Uuid::now_v7().to_string();
        let manifest = IngestManifest {
            machine_id: machine_id.to_owned(),
            batch_id: batch_id.clone(),
            artifacts: artifacts
                .iter()
                .filter(|artifact| !absent.contains(&artifact.sha256))
                .map(|artifact| ManifestArtifact {
                    sha256: artifact.sha256.clone(),
                    size: artifact.size,
                    source: artifact.source.clone(),
                    source_path: artifact.source_path.clone(),
                    modified_at: artifact.modified_at.clone(),
                })
                .collect(),
        };
        let receipt = match self.transport.submit_manifest(&manifest) {
            Ok(receipt) => receipt,
            Err(error) => {
                let claimed: Vec<QueuedArtifact> = artifacts
                    .iter()
                    .filter(|artifact| !absent.contains(&artifact.sha256))
                    .cloned()
                    .collect();
                record_failure(queue, &claimed, &error)?;
                return Err(error);
            }
        };
        // Reconcile against what the manifest actually claimed, not against the
        // whole batch: an artifact the server refused is excluded from the
        // manifest on purpose, and counting it here turned a partial success
        // into a protocol error that failed the run.
        let claimed = manifest.artifacts.len() as u64;
        let receipt_total = receipt.accepted.saturating_add(receipt.duplicate);
        if receipt.batch_id != batch_id || receipt_total != claimed {
            let error = DaemonError::Protocol(format!(
                "manifest receipt mismatch: batch {} accepted {} duplicate {} for {} artifacts",
                receipt.batch_id, receipt.accepted, receipt.duplicate, claimed
            ));
            queue.mark_retry_all(&artifacts, &error.to_string())?;
            return Err(error);
        }
        // Only what the manifest claimed is synced; the rest stays queued. By
        // the whole primary key, because two rows can carry the same bytes from
        // two different places and only one of them was in this manifest.
        for artifact in artifacts
            .iter()
            .filter(|artifact| !absent.contains(&artifact.sha256))
        {
            queue.mark_synced(&artifact.sha256, &artifact.source_path)?;
        }
        Ok(SyncReport {
            failed,
            batch_id: Some(batch_id),
            considered: artifacts.len(),
            uploaded,
            duplicates,
        })
    }
}

/// Charges these artifacts an attempt for a failure that was theirs, and only
/// records the reason for one that stopped the whole pass.
fn record_failure(
    queue: &OfflineQueue,
    artifacts: &[QueuedArtifact],
    error: &DaemonError,
) -> Result<(), DaemonError> {
    if error.is_pass_wide() {
        queue.mark_deferred(artifacts, &error.to_string())
    } else {
        queue.mark_retry_all(artifacts, &error.to_string())
    }
}
