//! Applying the capture policy to rows already in the queue.
//!
//! Capture leaves out what the policy excludes, but a queue can already hold
//! such rows: an older agent queued everything, and a policy can be narrowed
//! after the fact. Those rows are held, not deleted, so widening the policy
//! again brings them back without reading anything.

use chrono::{DateTime, Duration, Utc};
use rusqlite::params;
use serde::Serialize;
use std::path::Path;

use crate::error::DaemonError;
use crate::policy::{CapturePolicy, Verdict};
use crate::queue::OfflineQueue;
use crate::workspace::WorkspaceResolver;

const BACKFILL_ANCHOR: &str = "backfill_since";

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyApplied {
    /// Waiting rows the policy now leaves out.
    pub held: u64,
    /// Held rows the policy takes in again.
    pub released: u64,
}

struct Row {
    sha256: String,
    source_path: String,
    source: String,
    modified_at: String,
    workspace: Option<String>,
    held: bool,
}

impl OfflineQueue {
    /// The start of the default backfill window, fixed the first time it is
    /// asked for. Fixed rather than rolling, so a session from inside the
    /// window is still taken by a sync that runs weeks later.
    pub fn backfill_anchor(&self, window: Duration) -> Result<DateTime<Utc>, DaemonError> {
        if let Some(stored) = self.metadata(BACKFILL_ANCHOR)?
            && let Ok(anchor) = DateTime::parse_from_rfc3339(&stored)
        {
            return Ok(anchor.with_timezone(&Utc));
        }
        let anchor = Utc::now() - window;
        self.set_metadata(BACKFILL_ANCHOR, &anchor.to_rfc3339())?;
        Ok(anchor)
    }

    pub fn apply_policy(
        &self,
        policy: &CapturePolicy,
        resolver: &mut WorkspaceResolver,
    ) -> Result<PolicyApplied, DaemonError> {
        if policy == &CapturePolicy::everything() {
            let released = self.connection.execute(
                "UPDATE artifacts SET status = 'pending' WHERE status = 'held'",
                [],
            )? as u64;
            return Ok(PolicyApplied { held: 0, released });
        }
        let rows = self.unsynced_rows()?;
        let mut applied = PolicyApplied::default();
        self.batch(|| {
            for row in rows {
                let workspace = match row.workspace {
                    Some(known) => Some(known),
                    None if policy.has_project_rules() => {
                        let found = resolver.resolve(&row.source, Path::new(&row.source_path), None);
                        self.connection.execute(
                            "UPDATE artifacts SET workspace = ?3 WHERE sha256 = ?1 AND source_path = ?2",
                            params![row.sha256, row.source_path, found],
                        )?;
                        found
                    }
                    None => None,
                };
                let modified = DateTime::parse_from_rfc3339(&row.modified_at)
                    .map(|at| at.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now());
                let hold = policy.judge(modified, workspace.as_deref()) != Verdict::Capture;
                if hold == row.held {
                    continue;
                }
                let status = if hold { "held" } else { "pending" };
                self.connection.execute(
                    "UPDATE artifacts SET status = ?3 WHERE sha256 = ?1 AND source_path = ?2",
                    params![row.sha256, row.source_path, status],
                )?;
                if hold {
                    applied.held += 1;
                } else {
                    applied.released += 1;
                }
            }
            Ok(())
        })?;
        Ok(applied)
    }

    fn unsynced_rows(&self) -> Result<Vec<Row>, DaemonError> {
        let mut statement = self.connection.prepare(
            "SELECT sha256, source_path, source, modified_at, workspace, status FROM artifacts
             WHERE status IN ('pending', 'retry', 'held')",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Row {
                sha256: row.get(0)?,
                source_path: row.get(1)?,
                source: row.get(2)?,
                modified_at: row.get(3)?,
                workspace: row.get(4)?,
                held: row.get::<_, String>(5)? == "held",
            })
        })?;
        rows.collect::<Result<_, _>>().map_err(Into::into)
    }
}
