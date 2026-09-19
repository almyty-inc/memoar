//! The polling watcher and the stability window a file must sit still through.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::error::DaemonError;
use crate::queue::OfflineQueue;
use crate::redaction::RedactionConfig;
use memoar_connectors::{OperatingSystem, SOURCES, files_for_source};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileFingerprint {
    pub len: u64,
    pub modified: SystemTime,
}

#[derive(Debug)]
struct Observation {
    fingerprint: FileFingerprint,
    stable_since: SystemTime,
    emitted: bool,
}

/// Debounce primitive for polling watchers. A path is emitted once after its
/// size and modification time remain unchanged for the configured interval.
pub struct DebouncedChanges {
    debounce: Duration,
    observations: HashMap<PathBuf, Observation>,
}

impl DebouncedChanges {
    #[must_use]
    pub fn new(debounce: Duration) -> Self {
        Self {
            debounce,
            observations: HashMap::new(),
        }
    }

    pub fn observe(
        &mut self,
        path: PathBuf,
        fingerprint: FileFingerprint,
        now: SystemTime,
    ) -> bool {
        let observation = self.observations.entry(path).or_insert(Observation {
            fingerprint,
            stable_since: now,
            emitted: false,
        });
        if observation.fingerprint != fingerprint {
            observation.fingerprint = fingerprint;
            observation.stable_since = now;
            observation.emitted = false;
            return false;
        }
        if observation.emitted
            || now
                .duration_since(observation.stable_since)
                .unwrap_or_default()
                < self.debounce
        {
            return false;
        }
        observation.emitted = true;
        true
    }
}

/// Stateful polling watcher used by the daemon loop. Files are queued only
/// after a stable debounce window; subsequent mutations reset that window.
pub struct PollingCapture {
    changes: DebouncedChanges,
}

impl PollingCapture {
    #[must_use]
    pub fn new(debounce: Duration) -> Self {
        Self {
            changes: DebouncedChanges::new(debounce),
        }
    }

    pub fn scan(
        &mut self,
        queue: &OfflineQueue,
        home: &Path,
        os: OperatingSystem,
        enabled_sources: &HashSet<String>,
        redaction: RedactionConfig,
        now: SystemTime,
    ) -> Result<usize, DaemonError> {
        let mut captured = 0;
        for spec in SOURCES {
            if !enabled_sources.is_empty() && !enabled_sources.contains(spec.id) {
                continue;
            }
            for path in files_for_source(spec, home, os)? {
                let metadata = fs::metadata(&path).map_err(|source| DaemonError::Io {
                    path: path.clone(),
                    source,
                })?;
                let fingerprint = FileFingerprint {
                    len: metadata.len(),
                    modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                };
                if self.changes.observe(path.clone(), fingerprint, now) {
                    match queue.enqueue_with_redaction(spec.id, &path, redaction) {
                        Ok(_) => captured += 1,
                        // The same set the one-shot pass skips, named the same
                        // way. This branch listed two of the three refusals by
                        // hand, so `UnscannableSecret` fell through to the
                        // `return` below and a single non-UTF-8 file under
                        // ~/.claude/projects — a Zed write-ahead log, a Cursor
                        // state file, a transcript truncated mid-write — ended
                        // continuous capture for every source until the daemon
                        // was restarted, which would hit it again.
                        Err(error) if error.is_skippable() => {}
                        Err(other) => return Err(other),
                    }
                }
            }
        }
        Ok(captured)
    }
}
