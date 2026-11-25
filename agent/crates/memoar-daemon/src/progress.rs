//! How far a drain has got, for a person watching tens of thousands of uploads.

use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Artifacts waiting when the drain started, and their bytes.
    pub total: u64,
    pub total_bytes: u64,
    /// Artifacts settled so far, whichever way.
    pub done: u64,
    pub uploaded: u64,
    pub duplicates: u64,
    pub failed: u64,
    pub bytes_uploaded: u64,
    #[serde(skip)]
    pub elapsed: Duration,
}

impl Progress {
    /// Uploads a second since the drain started.
    #[must_use]
    pub fn rate(&self) -> f64 {
        let seconds = self.elapsed.as_secs_f64();
        if seconds <= 0.0 {
            return 0.0;
        }
        self.uploaded as f64 / seconds
    }

    /// Time left at the rate so far, when there is a rate to go on.
    #[must_use]
    pub fn eta(&self) -> Option<Duration> {
        let settled = self.done as f64 / self.elapsed.as_secs_f64().max(f64::EPSILON);
        let left = self.total.saturating_sub(self.done);
        (settled > 0.0 && left > 0).then(|| Duration::from_secs_f64(left as f64 / settled))
    }
}

/// Counts outcomes and hands a snapshot to whoever is watching.
pub(crate) struct Tracker<'a> {
    started: Instant,
    progress: Progress,
    report: &'a mut dyn FnMut(&Progress),
}

impl<'a> Tracker<'a> {
    pub(crate) fn new(total: u64, total_bytes: u64, report: &'a mut dyn FnMut(&Progress)) -> Self {
        Self {
            started: Instant::now(),
            progress: Progress {
                total,
                total_bytes,
                ..Progress::default()
            },
            report,
        }
    }

    pub(crate) fn uploaded(&mut self, bytes: u64) {
        self.progress.uploaded += 1;
        self.progress.bytes_uploaded += bytes;
        self.settled();
    }

    pub(crate) fn duplicates(&mut self, count: u64) {
        if count == 0 {
            return;
        }
        self.progress.duplicates += count;
        self.progress.done += count - 1;
        self.settled();
    }

    pub(crate) fn failed(&mut self) {
        self.progress.failed += 1;
        self.settled();
    }

    fn settled(&mut self) {
        self.progress.done += 1;
        self.progress.elapsed = self.started.elapsed();
        (self.report)(&self.progress);
    }
}
