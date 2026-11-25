//! What the last watch on this data directory did, kept where `status` can read it.
//!
//! A watch that stopped said so on the terminal it ran in, and nowhere else.
//! Once that terminal was gone, nothing on the machine knew capture had ended
//! or why, and `status` described a queue that looked like any other. The
//! watch now leaves this file behind: when it started, when a cycle last
//! uploaded, the failure it is retrying, and the reason it stopped.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::config::{RuntimePaths, atomic_replace};
use crate::error::AppError;

/// How often a healthy watch refreshes the file. Often enough that the last
/// upload it names is current to the minute, and rarely enough that a watch
/// polling every two seconds is not also writing a file every two seconds.
const REFRESH: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureState {
    pub(crate) pid: u32,
    pub(crate) started_at: Option<DateTime<Utc>>,
    pub(crate) last_cycle_at: Option<DateTime<Utc>>,
    pub(crate) last_success_at: Option<DateTime<Utc>>,
    /// The failure the watch is waiting out, cleared by the next good cycle.
    pub(crate) last_error: Option<Failure>,
    /// Why the watch ended, when it ended on a failure retrying cannot fix.
    pub(crate) stopped: Option<Failure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Failure {
    pub(crate) at: DateTime<Utc>,
    pub(crate) code: String,
    pub(crate) exit_code: u8,
    pub(crate) message: String,
    pub(crate) hint: String,
}

impl Failure {
    pub(crate) fn from_error(error: &AppError, at: DateTime<Utc>) -> Self {
        Self {
            at,
            code: error.code.clone(),
            exit_code: error.exit_code,
            message: error.message.clone(),
            hint: error.hint.clone(),
        }
    }
}

pub(crate) fn state_file(paths: &RuntimePaths) -> PathBuf {
    paths.data_dir.join("capture-state.json")
}

/// The recorded state, or none when no watch has written one. A damaged file
/// is treated as absent: it describes the past, and the next write replaces it.
pub(crate) fn load(paths: &RuntimePaths) -> Option<CaptureState> {
    let bytes = fs::read(state_file(paths)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(crate) fn save(paths: &RuntimePaths, state: &CaptureState) {
    // Best effort. Capture matters more than the note about it, and a full
    // disk is reported by the queue, which cannot work around it either.
    if let Ok(bytes) = serde_json::to_vec_pretty(state) {
        let _ = atomic_replace(&state_file(paths), &bytes, 0o600);
    }
}

/// Records a one-off `memoar sync` that uploaded, leaving the rest alone.
pub(crate) fn record_sync(paths: &RuntimePaths) {
    let mut state = load(paths).unwrap_or_default();
    state.last_success_at = Some(Utc::now());
    save(paths, &state);
}

/// The running watch's view of the file. Holds the state in memory and
/// writes it when something changed, or when a minute has passed.
pub(crate) struct StateRecorder<'a> {
    paths: &'a RuntimePaths,
    state: CaptureState,
    written: Instant,
}

impl<'a> StateRecorder<'a> {
    /// A new watch: whatever stopped the last one no longer describes this one.
    pub(crate) fn start(paths: &'a RuntimePaths) -> Self {
        let previous = load(paths).unwrap_or_default();
        let now = Utc::now();
        let state = CaptureState {
            pid: std::process::id(),
            started_at: Some(now),
            last_cycle_at: None,
            last_success_at: previous.last_success_at,
            last_error: None,
            stopped: None,
        };
        save(paths, &state);
        Self {
            paths,
            state,
            written: Instant::now(),
        }
    }

    pub(crate) fn succeeded(&mut self) {
        let now = Utc::now();
        let recovered = self.state.last_error.take().is_some();
        self.state.last_cycle_at = Some(now);
        self.state.last_success_at = Some(now);
        if recovered || self.written.elapsed() >= REFRESH {
            self.write();
        }
    }

    pub(crate) fn failed(&mut self, error: &AppError) {
        let now = Utc::now();
        let changed = self
            .state
            .last_error
            .as_ref()
            .is_none_or(|last| last.code != error.code || last.message != error.message);
        self.state.last_cycle_at = Some(now);
        self.state.last_error = Some(Failure::from_error(error, now));
        if changed || self.written.elapsed() >= REFRESH {
            self.write();
        }
    }

    pub(crate) fn stopped(&mut self, error: &AppError) {
        let now = Utc::now();
        self.state.last_cycle_at = Some(now);
        self.state.stopped = Some(Failure::from_error(error, now));
        self.write();
    }

    fn write(&mut self) {
        save(self.paths, &self.state);
        self.written = Instant::now();
    }
}
