//! One capture pass over every enabled source.

use memoar_connectors::{OperatingSystem, SOURCES, files_for_source};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::error::DaemonError;
use crate::queue::OfflineQueue;
use crate::redaction::RedactionConfig;

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
    let mut summary = CaptureSummary::default();
    for spec in SOURCES {
        if !enabled_sources.is_empty() && !enabled_sources.contains(spec.id) {
            continue;
        }
        for path in files_for_source(spec, home, os)? {
            match queue.enqueue_with_redaction(spec.id, &path, redaction) {
                Ok(_) => summary.captured += 1,
                // The file stays on your machine. One of those must not cost
                // you everything else.
                Err(error) if error.is_skippable() => summary.skipped.push(path),
                Err(other) => return Err(other),
            }
        }
    }
    Ok(summary)
}
