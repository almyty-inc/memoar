//! The delta sync pass: ask what is missing, upload it, then declare the batch.

use serde::Serialize;
use std::collections::HashSet;

use crate::blobs::PruneReport;
use crate::declare::{declare, record_failure};
use crate::error::DaemonError;
use crate::manifest::SyncTransport;
use crate::progress::{Progress, Tracker};
use crate::queue::{OfflineQueue, QueuedArtifact};
use crate::redaction::RedactionConfig;
use crate::upload::{Outcome, Pacer, upload_all};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub batch_id: Option<String>,
    pub considered: usize,
    pub uploaded: usize,
    pub duplicates: usize,
    /// Artifacts the server would not take. They stay queued for the next run.
    pub failed: usize,
    /// Sources that changed after they were hashed, queued again as they are.
    pub changed: usize,
    /// Sources deleted before they could be uploaded.
    pub vanished: usize,
    pub bytes_uploaded: u64,
    /// Private copies given back once nothing waiting needed them.
    pub copies: PruneReport,
}

impl SyncReport {
    fn absorb(&mut self, pass: &SyncReport) {
        self.considered += pass.considered;
        self.uploaded += pass.uploaded;
        self.duplicates += pass.duplicates;
        self.failed += pass.failed;
        self.changed += pass.changed;
        self.vanished += pass.vanished;
        self.bytes_uploaded += pass.bytes_uploaded;
        self.batch_id = pass.batch_id.clone().or(self.batch_id.take());
    }
}

/// A drain passes again after one that queued changed sources, but only this
/// many times: a transcript being written to as fast as it is read would
/// otherwise keep the drain busy for as long as the session runs.
const CHANGED_PASSES: usize = 3;

pub struct SyncEngine<T> {
    transport: T,
    batch_limit: usize,
    workers: usize,
    pacer: Option<Pacer>,
    requeue: Option<RedactionConfig>,
}

impl<T: SyncTransport + Sync> SyncEngine<T> {
    #[must_use]
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            batch_limit: 256,
            workers: 1,
            pacer: None,
            requeue: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_batch_limit(transport: T, batch_limit: usize) -> Self {
        Self {
            batch_limit,
            ..Self::new(transport)
        }
    }

    /// Up to `workers` uploads in flight at once.
    #[must_use]
    pub fn with_workers(mut self, workers: usize) -> Self {
        self.workers = workers.max(1);
        self
    }

    /// Uploads spaced to at most `per_minute` a minute. 0 does not pace.
    ///
    /// The archive allows each route 300 requests a minute. Sending as fast
    /// as possible spent that in seconds, then every request waited out a
    /// 429 and a whole minute's `Retry-After`: progress came in bursts.
    #[must_use]
    pub fn with_upload_rate(mut self, per_minute: u32) -> Self {
        self.pacer = Pacer::per_minute(per_minute);
        self
    }

    /// Re-queue a source that changed after it was hashed, with this redaction.
    #[must_use]
    pub fn with_requeue(mut self, redaction: RedactionConfig) -> Self {
        self.requeue = Some(redaction);
        self
    }

    pub fn drain(&self, queue: &OfflineQueue, machine_id: &str) -> Result<SyncReport, DaemonError> {
        self.drain_with_progress(queue, machine_id, &mut |_| {})
    }

    /// Passes until the queue has nothing left that is due, then deletes the
    /// copies nothing waiting needs.
    ///
    /// A pass takes at most `batch_limit` artifacts, and `memoar sync` used
    /// to run one: a first sync of 1,000 sessions uploaded 256 and reported
    /// success. A pass that fills its batch is followed by another. It ends
    /// because every artifact a pass offered is either synced or waiting out a
    /// backoff, so the next pass never offers it again.
    pub fn drain_with_progress(
        &self,
        queue: &OfflineQueue,
        machine_id: &str,
        report: &mut dyn FnMut(&Progress),
    ) -> Result<SyncReport, DaemonError> {
        let waiting = queue.activity()?;
        let mut tracker = Tracker::new(waiting.waiting, waiting.waiting_bytes, report);
        let mut total = SyncReport::default();
        let mut changed_passes = 0;
        // A ceiling as well, so a queue that misbehaves cannot spin a sync
        // for ever: 4,096 passes is a million artifacts.
        for _ in 0..4096 {
            let last = self.pass(queue, machine_id, &mut tracker)?;
            total.absorb(&last);
            if last.considered >= self.batch_limit {
                continue;
            }
            if last.changed > 0 && changed_passes < CHANGED_PASSES {
                changed_passes += 1;
                continue;
            }
            break;
        }
        // A watch drains every few seconds, mostly finding nothing. Pruning
        // scans the queue and the blob directory, so it runs when this drain
        // settled something.
        if total.considered > 0 {
            total.copies = queue.prune_blobs()?;
        }
        Ok(total)
    }

    #[cfg(test)]
    pub(crate) fn transport(&self) -> &T {
        &self.transport
    }

    pub fn sync(&self, queue: &OfflineQueue, machine_id: &str) -> Result<SyncReport, DaemonError> {
        let mut quiet = |_: &Progress| {};
        self.pass(queue, machine_id, &mut Tracker::new(0, 0, &mut quiet))
    }

    fn pass(
        &self,
        queue: &OfflineQueue,
        machine_id: &str,
        tracker: &mut Tracker<'_>,
    ) -> Result<SyncReport, DaemonError> {
        let artifacts = queue.pending(self.batch_limit)?;
        if artifacts.is_empty() {
            return Ok(SyncReport::default());
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
        let jobs: Vec<usize> = (0..artifacts.len())
            .filter(|index| missing.contains(&artifacts[*index].sha256))
            .collect();
        // Counted, not derived. `considered - uploaded` reported every failed
        // upload as a duplicate.
        let mut report = SyncReport {
            considered: artifacts.len(),
            duplicates: artifacts.len() - jobs.len(),
            ..SyncReport::default()
        };
        tracker.duplicates(report.duplicates as u64);
        let outcomes = upload_all(
            &self.transport,
            &artifacts,
            &jobs,
            self.workers,
            self.pacer.as_ref(),
            |_, outcome| match outcome {
                Outcome::Uploaded(bytes) => tracker.uploaded(*bytes),
                Outcome::PassWide(_) => {}
                _ => tracker.failed(),
            },
        );
        // Hashes the server does not have and this pass could not give it. The
        // manifest must not name them: it is a claim that these bytes are in
        // the archive, and the server checks.
        let mut absent: HashSet<String> = HashSet::new();
        let mut stopped: Option<DaemonError> = None;
        let mut untried: Vec<QueuedArtifact> = Vec::new();
        for (job, outcome) in jobs.iter().zip(outcomes) {
            let artifact = &artifacts[*job];
            let outcome = match outcome {
                Some(Outcome::PassWide(error)) => {
                    stopped.get_or_insert(error);
                    None
                }
                other => other,
            };
            let Some(outcome) = outcome else {
                untried.push(artifact.clone());
                continue;
            };
            if !matches!(outcome, Outcome::Uploaded(_)) {
                absent.insert(artifact.sha256.clone());
            }
            match outcome {
                Outcome::Uploaded(bytes) => {
                    report.uploaded += 1;
                    report.bytes_uploaded += bytes;
                }
                // One artifact the server will not take must not block the
                // rest. The queue remembers, and the loop carries on.
                Outcome::Failed(error) => {
                    queue.mark_retry(
                        &artifact.sha256,
                        &artifact.source_path,
                        &error.to_string(),
                    )?;
                    report.failed += 1;
                }
                Outcome::Changed => {
                    queue.supersede(artifact, self.requeue)?;
                    report.changed += 1;
                }
                Outcome::Vanished => {
                    queue.forget(artifact)?;
                    report.vanished += 1;
                }
                Outcome::PassWide(_) => unreachable!("taken out above"),
            }
        }
        if let Some(error) = stopped {
            // Nothing after this one will get through either. What was
            // uploaded already is in the archive by its hash, so the next
            // pass finds it there and declares it then.
            queue.mark_deferred(&untried, &error.to_string())?;
            return Err(error);
        }
        declare(
            &self.transport,
            queue,
            machine_id,
            &artifacts,
            &absent,
            report,
        )
    }
}
