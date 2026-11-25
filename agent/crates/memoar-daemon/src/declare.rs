//! The end of a pass: declare what reached the archive, and settle those rows.

use std::collections::HashSet;
use uuid::Uuid;

use crate::error::DaemonError;
use crate::manifest::{IngestManifest, ManifestArtifact, SyncTransport};
use crate::queue::{OfflineQueue, QueuedArtifact};
use crate::sync::SyncReport;

/// Submits the manifest for what this pass put in the archive, and marks
/// exactly that synced.
pub(crate) fn declare<T: SyncTransport>(
    transport: &T,
    queue: &OfflineQueue,
    machine_id: &str,
    artifacts: &[QueuedArtifact],
    absent: &HashSet<String>,
    mut report: SyncReport,
) -> Result<SyncReport, DaemonError> {
    let claimed: Vec<&QueuedArtifact> = artifacts
        .iter()
        .filter(|artifact| !absent.contains(&artifact.sha256))
        .collect();
    let batch_id = Uuid::now_v7().to_string();
    let manifest = IngestManifest {
        machine_id: machine_id.to_owned(),
        batch_id: batch_id.clone(),
        artifacts: claimed
            .iter()
            .map(|artifact| ManifestArtifact {
                sha256: artifact.sha256.clone(),
                size: artifact.size,
                source: artifact.source.clone(),
                source_path: artifact.source_path.clone(),
                modified_at: artifact.modified_at.clone(),
            })
            .collect(),
    };
    let receipt = match transport.submit_manifest(&manifest) {
        Ok(receipt) => receipt,
        Err(error) => {
            let claimed: Vec<QueuedArtifact> = claimed.into_iter().cloned().collect();
            record_failure(queue, &claimed, &error)?;
            return Err(error);
        }
    };
    // Reconciled against what the manifest claimed, not the whole batch:
    // an artifact the server refused is left out of it on purpose.
    let receipt_total = receipt.accepted.saturating_add(receipt.duplicate);
    if receipt.batch_id != batch_id || receipt_total != claimed.len() as u64 {
        let error = DaemonError::Protocol(format!(
            "manifest receipt mismatch: batch {} accepted {} duplicate {} for {} artifacts",
            receipt.batch_id,
            receipt.accepted,
            receipt.duplicate,
            claimed.len()
        ));
        queue.mark_retry_all(artifacts, &error.to_string())?;
        return Err(error);
    }
    // By the whole primary key, because two rows can carry the same bytes
    // from two different places and only one of them was in this manifest.
    // A copy is deleted as soon as its row is synced, not at the end of a
    // drain that may run for hours.
    queue.batch(|| {
        for artifact in &claimed {
            queue.mark_synced(&artifact.sha256, &artifact.source_path)?;
            queue.drop_copy(artifact)?;
        }
        Ok(())
    })?;
    report.batch_id = Some(batch_id);
    Ok(report)
}

/// Charges these artifacts an attempt for a failure that was theirs, and only
/// records the reason for one that stopped the whole pass.
pub(crate) fn record_failure(
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
