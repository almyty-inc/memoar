//! The capture half of a sync: give back old copies, hold back what the policy
//! leaves out, and take what it takes, unless the disk is at its floor.

use memoar_connectors::OperatingSystem;
use memoar_daemon::{
    CapturePolicy, CaptureSummary, DaemonError, OfflineQueue, capture_sources_with_policy,
};
use serde_json::{Value, json};
use std::collections::HashSet;

use crate::capture_policy::{Origin, human_bytes, policy_value};
use crate::config::{Config, RuntimePaths};
use crate::error::{AppError, map_capture_error, map_queue_error};

pub(crate) struct Captured {
    pub(crate) summary: CaptureSummary,
    /// Capture did not read new files because the disk is at its floor. The
    /// sync still uploads what was queued before, and then reports this.
    pub(crate) refused: Option<AppError>,
}

pub(crate) fn capture_step(
    queue: &OfflineQueue,
    paths: &RuntimePaths,
    config: &Config,
    enabled: &HashSet<String>,
    policy: &CapturePolicy,
) -> Result<Captured, AppError> {
    // First, because it is the one step that frees space: a queue written by
    // an older agent holds a copy of every artifact it took.
    queue.prune_blobs().map_err(map_queue_error)?;
    match capture_sources_with_policy(
        queue,
        &paths.home,
        OperatingSystem::current(),
        enabled,
        config.redaction,
        policy,
    ) {
        Ok(summary) => Ok(Captured {
            summary,
            refused: None,
        }),
        Err(error @ DaemonError::DiskLow { .. }) => Ok(Captured {
            summary: CaptureSummary::default(),
            refused: Some(AppError::disk_low(format!(
                "Nothing new was captured: {error}"
            ))),
        }),
        Err(other) => Err(map_capture_error(other)),
    }
}

/// What the policy left out this run, and how to take it in.
pub(crate) fn backfill_value(
    summary: &CaptureSummary,
    policy: &CapturePolicy,
    origin: Origin,
) -> Value {
    let mut value = policy_value(policy, origin);
    value["olderSkipped"] = json!(summary.too_old);
    value["excluded"] = json!(summary.excluded);
    value["unchanged"] = json!(summary.unchanged);
    value["held"] = json!(summary.policy.held);
    value["released"] = json!(summary.policy.released);
    if let Some(hint) = backfill_hint(summary, policy) {
        value["hint"] = json!(hint);
    }
    value
}

fn backfill_hint(summary: &CaptureSummary, policy: &CapturePolicy) -> Option<String> {
    let older = summary.too_old;
    if older.files == 0 && summary.policy.held == 0 {
        return None;
    }
    let since = policy
        .since
        .map(|since| since.format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    Some(format!(
        "{} sessions ({}) last changed before {since} were left out, and {} already queued are held back. Run memoar sync --plan to see them by project, memoar sync --since all to take them once, or memoar policy --since all to keep taking them.",
        older.files,
        human_bytes(older.bytes),
        summary.policy.held
    ))
}
