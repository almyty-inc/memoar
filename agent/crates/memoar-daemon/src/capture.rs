//! One capture pass over every enabled source, within the capture policy.

use memoar_connectors::{OperatingSystem, SOURCES, files_for_source};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::enqueue::{modified_instant, read_source, stat_within_limit};
use crate::error::DaemonError;
use crate::held::PolicyApplied;
use crate::policy::{CapturePolicy, Verdict};
use crate::queue::OfflineQueue;
use crate::redaction::RedactionConfig;
use crate::workspace::WorkspaceResolver;

/// Files queued per transaction.
const CHUNK: usize = 256;

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    pub files: u64,
    pub bytes: u64,
}

impl Tally {
    pub(crate) fn add(&mut self, bytes: u64) {
        self.files += 1;
        self.bytes += bytes;
    }
}

/// What a capture pass did, including what it could not take.
///
/// A file that cannot be redacted is not uploaded — that is the fail-closed
/// promise and it holds. But it used to abort the whole pass, so one binary
/// file under a source directory meant nothing at all was archived, from any
/// source. It is skipped and counted now, and the count is reported, because a
/// file quietly dropped is its own kind of dishonesty.
#[derive(Debug, Default, Clone)]
pub struct CaptureSummary {
    pub captured: usize,
    pub skipped: Vec<PathBuf>,
    /// Files already queued exactly as they are now, which were not read.
    pub unchanged: u64,
    /// Files last modified before the backfill bound, left where they are.
    pub too_old: Tally,
    /// Files in a project the policy leaves out.
    pub excluded: Tally,
    /// Rows already queued that the policy now holds back, or takes in again.
    pub policy: PolicyApplied,
}

/// What capture does with one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileOutcome {
    Captured,
    Unchanged,
    TooOld(u64),
    Excluded(u64),
}

impl CaptureSummary {
    pub(crate) fn record(&mut self, outcome: FileOutcome) {
        match outcome {
            FileOutcome::Captured => self.captured += 1,
            FileOutcome::Unchanged => self.unchanged += 1,
            FileOutcome::TooOld(bytes) => self.too_old.add(bytes),
            FileOutcome::Excluded(bytes) => self.excluded.add(bytes),
        }
    }
}

/// What a capture needs besides the queue, shared by the one-shot pass and the
/// watcher so the two cannot disagree about a file.
pub(crate) struct FileCapture<'a> {
    pub(crate) queue: &'a OfflineQueue,
    pub(crate) redaction: RedactionConfig,
    pub(crate) policy: &'a CapturePolicy,
    pub(crate) resolver: &'a mut WorkspaceResolver,
}

impl FileCapture<'_> {
    /// Cheapest question first: a `stat` answers whether it is queued already
    /// and whether it is too old, and only then is the file read.
    pub(crate) fn file(&mut self, source: &str, path: &Path) -> Result<FileOutcome, DaemonError> {
        let metadata = stat_within_limit(path)?;
        if self.queue.already_queued(path, &metadata, self.redaction)? {
            return Ok(FileOutcome::Unchanged);
        }
        let size = metadata.len();
        if self.policy.by_age(modified_instant(&metadata)) != Verdict::Capture {
            return Ok(FileOutcome::TooOld(size));
        }
        let excluded =
            |workspace: Option<&str>| self.policy.by_project(workspace) != Verdict::Capture;
        if let Some(known) = self.resolver.cached(source, path)
            && excluded(known.as_deref())
        {
            return Ok(FileOutcome::Excluded(size));
        }
        let bytes = read_source(path)?;
        let workspace = self.resolver.resolve(source, path, Some(&bytes));
        if excluded(workspace.as_deref()) {
            return Ok(FileOutcome::Excluded(size));
        }
        self.queue.enqueue_bytes(
            source,
            path,
            &metadata,
            &bytes,
            self.redaction,
            workspace.as_deref(),
        )?;
        Ok(FileOutcome::Captured)
    }
}

pub fn capture_sources(
    queue: &OfflineQueue,
    home: &Path,
    os: OperatingSystem,
    enabled_sources: &HashSet<String>,
) -> Result<usize, DaemonError> {
    capture_sources_with_redaction(
        queue,
        home,
        os,
        enabled_sources,
        RedactionConfig::disabled(),
    )
    .map(|summary| summary.captured)
}

pub fn capture_sources_with_redaction(
    queue: &OfflineQueue,
    home: &Path,
    os: OperatingSystem,
    enabled_sources: &HashSet<String>,
    redaction: RedactionConfig,
) -> Result<CaptureSummary, DaemonError> {
    capture_sources_with_policy(
        queue,
        home,
        os,
        enabled_sources,
        redaction,
        &CapturePolicy::everything(),
    )
}

/// Captures what the policy takes, after holding back queued rows it does not.
///
/// Refuses to read new files when the queue's volume is already at its
/// free-space floor, and stops if it reaches it part way. What was queued
/// before the stop stays queued.
pub fn capture_sources_with_policy(
    queue: &OfflineQueue,
    home: &Path,
    os: OperatingSystem,
    enabled_sources: &HashSet<String>,
    redaction: RedactionConfig,
    policy: &CapturePolicy,
) -> Result<CaptureSummary, DaemonError> {
    // Holding rows back is a few small updates, and it is what keeps a full
    // disk's drain from uploading everything an older agent queued. So it
    // runs before the space check, not after it.
    let mut resolver = WorkspaceResolver::new();
    let mut summary = CaptureSummary {
        policy: queue.apply_policy(policy, &mut resolver)?,
        ..CaptureSummary::default()
    };
    queue.ensure_space(0)?;
    let mut capture = FileCapture {
        queue,
        redaction,
        policy,
        resolver: &mut resolver,
    };
    for spec in SOURCES {
        if !enabled_sources.is_empty() && !enabled_sources.contains(spec.id) {
            continue;
        }
        let files = files_for_source(spec, home, os)?;
        for chunk in files.chunks(CHUNK) {
            queue.ensure_space(0)?;
            queue.batch(|| {
                for path in chunk {
                    match capture.file(spec.id, path) {
                        Ok(outcome) => summary.record(outcome),
                        // The file stays on your machine. One of those must
                        // not cost you everything else.
                        Err(error) if error.is_skippable() => summary.skipped.push(path.clone()),
                        Err(other) => return Err(other),
                    }
                }
                Ok(())
            })?;
        }
    }
    Ok(summary)
}
