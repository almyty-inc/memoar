//! Reading, verifying and uploading the artifacts one pass sends.
//!
//! A row usually has no copy of its bytes: they are read from the source file
//! here and checked against the hash taken at capture. A source that changed
//! since is not sent under the old hash; the pass queues it again instead.
//! Several uploads may be in flight, and a shared pacer keeps them inside the
//! archive's per-route request budget.

use std::io::ErrorKind;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::enqueue::sha256_bytes;
use crate::error::DaemonError;
use crate::manifest::SyncTransport;
use crate::queue::QueuedArtifact;

/// What became of one artifact the server said it was missing.
#[derive(Debug)]
pub(crate) enum Outcome {
    Uploaded(u64),
    /// Refused, or unreadable: charged an attempt and retried later.
    Failed(DaemonError),
    /// Stopped the whole pass. Nothing after it is tried.
    PassWide(DaemonError),
    /// The source no longer holds the bytes that were hashed.
    Changed,
    /// The source is gone, and there is no copy.
    Vanished,
}

/// Spaces requests evenly so a long drain stays under a per-minute budget
/// rather than spending it in the first seconds and waiting out the rest.
pub(crate) struct Pacer {
    interval: Duration,
    next: Mutex<Instant>,
}

impl Pacer {
    pub(crate) fn per_minute(requests: u32) -> Option<Self> {
        (requests > 0).then(|| Self {
            interval: Duration::from_secs(60) / requests,
            next: Mutex::new(Instant::now()),
        })
    }

    fn wait(&self) {
        let slot = {
            let mut next = self
                .next
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let slot = (*next).max(Instant::now());
            *next = slot + self.interval;
            slot
        };
        thread::sleep(slot.saturating_duration_since(Instant::now()));
    }
}

/// Uploads `jobs` (indices into `artifacts`) on up to `workers` threads.
///
/// Returns one entry per job, in job order; `None` is a job never started
/// because an earlier one stopped the pass. `seen` is told about each outcome
/// as it arrives, on the calling thread.
pub(crate) fn upload_all<T: SyncTransport + Sync>(
    transport: &T,
    artifacts: &[QueuedArtifact],
    jobs: &[usize],
    workers: usize,
    pacer: Option<&Pacer>,
    mut seen: impl FnMut(&QueuedArtifact, &Outcome),
) -> Vec<Option<Outcome>> {
    let mut results: Vec<Option<Outcome>> = jobs.iter().map(|_| None).collect();
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let (sender, receiver) = mpsc::channel();
    thread::scope(|scope| {
        for _ in 0..workers.clamp(1, jobs.len().max(1)) {
            let sender = sender.clone();
            let (next, stop) = (&next, &stop);
            scope.spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(&job) = jobs.get(index) else { break };
                    let outcome = upload_one(transport, &artifacts[job], pacer);
                    if matches!(outcome, Outcome::PassWide(_)) {
                        stop.store(true, Ordering::SeqCst);
                    }
                    if sender.send((index, outcome)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(sender);
        for (index, outcome) in receiver {
            seen(&artifacts[jobs[index]], &outcome);
            results[index] = Some(outcome);
        }
    });
    results
}

fn upload_one<T: SyncTransport>(
    transport: &T,
    artifact: &QueuedArtifact,
    pacer: Option<&Pacer>,
) -> Outcome {
    let bytes = match read_verified(artifact) {
        Ok(bytes) => bytes,
        Err(outcome) => return outcome,
    };
    let size = bytes.len() as u64;
    if let Some(pacer) = pacer {
        pacer.wait();
    }
    match transport.upload(artifact, bytes) {
        Ok(()) => Outcome::Uploaded(size),
        Err(error) if error.is_pass_wide() => Outcome::PassWide(error),
        Err(error) => Outcome::Failed(error),
    }
}

/// The bytes to upload, checked against the hash the row was queued under.
fn read_verified(artifact: &QueuedArtifact) -> Result<Vec<u8>, Outcome> {
    if let Some(blob) = &artifact.local_path {
        match std::fs::read(blob) {
            Ok(bytes) if sha256_bytes(&bytes) == artifact.sha256 => return Ok(bytes),
            Ok(_) => {
                return Err(Outcome::Failed(DaemonError::Protocol(format!(
                    "queued blob {} failed SHA-256 verification",
                    artifact.sha256
                ))));
            }
            // A copy that is gone, of bytes the source held unchanged, can
            // still be sent from the source. Redacted bytes cannot.
            Err(error) if error.kind() == ErrorKind::NotFound && !artifact.redacted => {}
            Err(source) => {
                return Err(Outcome::Failed(DaemonError::Io {
                    path: blob.clone(),
                    source,
                }));
            }
        }
    }
    let path = std::path::Path::new(&artifact.source_path);
    match std::fs::metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Err(Outcome::Vanished),
        Ok(metadata) if metadata.len() != artifact.size => return Err(Outcome::Changed),
        _ => {}
    }
    match std::fs::read(path) {
        Ok(bytes) if sha256_bytes(&bytes) == artifact.sha256 => Ok(bytes),
        Ok(_) => Err(Outcome::Changed),
        Err(error) if error.kind() == ErrorKind::NotFound => Err(Outcome::Vanished),
        Err(source) => Err(Outcome::Failed(DaemonError::Io {
            path: path.to_path_buf(),
            source,
        })),
    }
}
