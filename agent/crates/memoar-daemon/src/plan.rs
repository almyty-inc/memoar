//! What a capture would take, per source and per project, without taking it.
//!
//! Reads `stat` for every file and the head of a file only where its
//! workspace is not known yet. Writes nothing, so it is safe to run on a disk
//! that is already full.

use memoar_connectors::{OperatingSystem, SOURCES, files_for_source};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use crate::capture::Tally;
use crate::enqueue::{modified_instant, stat_within_limit};
use crate::error::DaemonError;
use crate::policy::{CapturePolicy, Verdict};
use crate::queue::OfflineQueue;
use crate::redaction::RedactionConfig;
use crate::workspace::WorkspaceResolver;

/// A file with no workspace in its records.
pub const UNKNOWN_WORKSPACE: &str = "(unknown)";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCounts {
    /// Every file the source's patterns name.
    pub found: Tally,
    /// Inside the policy and not queued yet: what the next sync reads and uploads.
    pub to_capture: Tally,
    /// Already queued exactly as it is now.
    pub queued: Tally,
    pub too_old: Tally,
    pub excluded: Tally,
    /// Past the size the archive accepts.
    pub too_large: Tally,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPlan {
    pub workspace: String,
    #[serde(flatten)]
    pub counts: PlanCounts,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePlan {
    pub source: String,
    #[serde(flatten)]
    pub counts: PlanCounts,
    /// Largest first.
    pub projects: Vec<ProjectPlan>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePlan {
    pub policy: CapturePolicy,
    pub totals: PlanCounts,
    pub sources: Vec<SourcePlan>,
}

pub fn plan_capture(
    queue: Option<&OfflineQueue>,
    home: &Path,
    os: OperatingSystem,
    enabled_sources: &HashSet<String>,
    redaction: RedactionConfig,
    policy: &CapturePolicy,
) -> Result<CapturePlan, DaemonError> {
    let mut resolver = WorkspaceResolver::new();
    let mut totals = PlanCounts::default();
    let mut sources = Vec::new();
    for spec in SOURCES {
        if !enabled_sources.is_empty() && !enabled_sources.contains(spec.id) {
            continue;
        }
        let mut counts = PlanCounts::default();
        let mut projects: BTreeMap<String, PlanCounts> = BTreeMap::new();
        for path in files_for_source(spec, home, os)? {
            let workspace = resolver.resolve(spec.id, &path, None);
            let Some((bucket, size)) =
                classify(queue, &path, redaction, policy, workspace.as_deref())?
            else {
                continue;
            };
            let workspace = workspace.unwrap_or_else(|| UNKNOWN_WORKSPACE.to_owned());
            for target in [
                &mut totals,
                &mut counts,
                projects.entry(workspace).or_default(),
            ] {
                target.found.add(size);
                bucket.of(target).add(size);
            }
        }
        if counts.found.files == 0 {
            continue;
        }
        let mut projects: Vec<ProjectPlan> = projects
            .into_iter()
            .map(|(workspace, counts)| ProjectPlan { workspace, counts })
            .collect();
        projects.sort_by_key(|project| std::cmp::Reverse(project.counts.found.bytes));
        sources.push(SourcePlan {
            source: spec.id.to_owned(),
            counts,
            projects,
        });
    }
    Ok(CapturePlan {
        policy: policy.clone(),
        totals,
        sources,
    })
}

#[derive(Clone, Copy)]
enum Bucket {
    Capture,
    Queued,
    TooOld,
    Excluded,
    TooLarge,
}

impl Bucket {
    fn of(self, counts: &mut PlanCounts) -> &mut Tally {
        match self {
            Bucket::Capture => &mut counts.to_capture,
            Bucket::Queued => &mut counts.queued,
            Bucket::TooOld => &mut counts.too_old,
            Bucket::Excluded => &mut counts.excluded,
            Bucket::TooLarge => &mut counts.too_large,
        }
    }
}

/// Which bucket a file falls in and its size, or `None` for a file that
/// vanished between listing and `stat`.
fn classify(
    queue: Option<&OfflineQueue>,
    path: &Path,
    redaction: RedactionConfig,
    policy: &CapturePolicy,
    workspace: Option<&str>,
) -> Result<Option<(Bucket, u64)>, DaemonError> {
    let metadata = match stat_within_limit(path) {
        Ok(metadata) => metadata,
        Err(DaemonError::TooLarge { size, .. }) => return Ok(Some((Bucket::TooLarge, size))),
        Err(_) => return Ok(None),
    };
    let size = metadata.len();
    if let Some(queue) = queue
        && queue.already_queued(path, &metadata, redaction)?
    {
        return Ok(Some((Bucket::Queued, size)));
    }
    let bucket = match policy.judge(modified_instant(&metadata), workspace) {
        Verdict::Capture => Bucket::Capture,
        Verdict::TooOld => Bucket::TooOld,
        Verdict::Excluded => Bucket::Excluded,
    };
    Ok(Some((bucket, size)))
}
