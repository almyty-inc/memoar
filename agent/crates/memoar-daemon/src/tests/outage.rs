use chrono::Utc;
use std::collections::HashSet;
use std::fs;
use std::sync::Mutex;

use crate::error::DaemonError;
use crate::manifest::{IngestManifest, IngestReceipt, SyncTransport};
use crate::queue::{OfflineQueue, QueuedArtifact};
use crate::sync::SyncEngine;

/// An archive that takes `succeed` uploads and then drops off the network,
/// or answers `refuse_delta` to the very first question.
struct OutageTransport {
    succeed: usize,
    uploads: Mutex<usize>,
    refuse_delta: Option<u16>,
}

impl SyncTransport for OutageTransport {
    fn missing(&self, _machine: &str, hashes: &[String]) -> Result<HashSet<String>, DaemonError> {
        if let Some(status) = self.refuse_delta {
            return Err(DaemonError::Http {
                status,
                body: r#"{"detail":"Valid credentials are required"}"#.to_owned(),
            });
        }
        Ok(hashes.iter().cloned().collect())
    }

    fn upload(&self, _artifact: &QueuedArtifact, _bytes: Vec<u8>) -> Result<(), DaemonError> {
        let mut uploads = self.uploads.lock().unwrap();
        *uploads += 1;
        if *uploads > self.succeed {
            return Err(DaemonError::Unreachable("connection refused".to_owned()));
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

fn queue_with(temp: &tempfile::TempDir, count: usize) -> OfflineQueue {
    let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
    for index in 0..count {
        let source = temp.path().join(format!("session-{index}.jsonl"));
        fs::write(&source, format!("session {index}")).unwrap();
        queue.enqueue("fixture", &source).unwrap();
    }
    queue
}

/// The archive going away mid-batch used to be charged to every artifact
/// left in it, one request and one attempt each. On a network that drops
/// packets rather than refusing them that is a 20-second connect timeout per
/// artifact, and eight outages abandoned the artifact for good.
#[test]
fn an_archive_that_goes_away_mid_batch_stops_the_pass_and_costs_no_attempts() {
    let temp = tempfile::tempdir().unwrap();
    let queue = queue_with(&temp, 5);
    let transport = OutageTransport {
        succeed: 2,
        uploads: Mutex::new(0),
        refuse_delta: None,
    };
    let engine = SyncEngine::new(transport);
    let error = engine.sync(&queue, "machine").unwrap_err();
    assert!(error.is_pass_wide(), "{error}");

    let now = queue.pending_at(10, Utc::now()).unwrap();
    assert_eq!(
        now.len(),
        5,
        "every artifact stays eligible for the next pass"
    );
    assert!(
        now.iter().all(|artifact| artifact.attempts == 0),
        "an outage is not the artifact's fault: {:?}",
        now.iter()
            .map(|artifact| artifact.attempts)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        now.iter()
            .filter(|artifact| artifact.last_error.is_some())
            .count(),
        3,
        "the three never sent say why"
    );
}

#[test]
fn the_pass_stops_at_the_first_unreachable_upload() {
    let temp = tempfile::tempdir().unwrap();
    let queue = queue_with(&temp, 6);
    let engine = SyncEngine::new(OutageTransport {
        succeed: 1,
        uploads: Mutex::new(0),
        refuse_delta: None,
    });
    let _ = engine.sync(&queue, "machine");
    // One that worked, one that found the archive gone, and nothing after.
    let asked = *engine_uploads(&engine);
    assert_eq!(asked, 2, "kept asking a dead archive {asked} times");
}

fn engine_uploads(engine: &SyncEngine<OutageTransport>) -> std::sync::MutexGuard<'_, usize> {
    engine.transport().uploads.lock().unwrap()
}

/// A revoked machine token is refused on the first request of the pass, and
/// that is a fact about the credential, not about any transcript.
#[test]
fn a_refused_credential_charges_no_artifact_an_attempt() {
    let temp = tempfile::tempdir().unwrap();
    let queue = queue_with(&temp, 3);
    let engine = SyncEngine::new(OutageTransport {
        succeed: 0,
        uploads: Mutex::new(0),
        refuse_delta: Some(401),
    });
    let error = engine.sync(&queue, "machine").unwrap_err();
    assert_eq!(
        error.to_string(),
        "HTTP 401: Valid credentials are required"
    );
    let now = queue.pending_at(10, Utc::now()).unwrap();
    assert_eq!(now.len(), 3);
    assert!(now.iter().all(|artifact| artifact.attempts == 0));
}

/// What is the artifact's own fault is still charged, so the cap still ends
/// an artifact the archive will never take.
#[test]
fn a_refusal_of_one_artifact_is_still_charged_to_it() {
    let temp = tempfile::tempdir().unwrap();
    let queue = queue_with(&temp, 1);
    let engine = SyncEngine::new(OutageTransport {
        succeed: 0,
        uploads: Mutex::new(0),
        refuse_delta: Some(400),
    });
    engine.sync(&queue, "machine").unwrap_err();
    let later = queue
        .pending_at(10, Utc::now() + chrono::Duration::hours(12))
        .unwrap();
    assert_eq!(later[0].attempts, 1);
}
