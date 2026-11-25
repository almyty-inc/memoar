//! `memoar sync --plan`: what a capture would take, before it takes anything.

use memoar_connectors::OperatingSystem;
use memoar_daemon::{CapturePlan, OfflineQueue, PlanCounts, Tally, plan_capture};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fmt::Write;

use crate::CommandOutput;
use crate::args::SyncArgs;
use crate::capture_policy::{Origin, disk_value, effective_policy, human_bytes, policy_value};
use crate::config::{Config, RuntimePaths};
use crate::error::AppError;
use crate::error::{map_capture_error, map_queue_error};

/// Projects listed per source in the text report. The JSON lists all.
const PROJECTS_SHOWN: usize = 12;

pub(crate) fn plan(
    args: &SyncArgs,
    json_mode: bool,
    paths: &RuntimePaths,
    config: &Config,
    enabled: &HashSet<String>,
) -> Result<CommandOutput, AppError> {
    // Only a queue that exists is opened: a plan on a machine that has never
    // synced must not be the thing that creates one.
    let queue = paths
        .queue_file()
        .exists()
        .then(|| OfflineQueue::open(&paths.queue_file()))
        .transpose()
        .map_err(map_queue_error)?;
    let (policy, origin) = effective_policy(config, queue.as_ref(), args.since.as_deref())?;
    let plan = plan_capture(
        queue.as_ref(),
        &paths.home,
        OperatingSystem::current(),
        enabled,
        config.redaction,
        &policy,
    )
    .map_err(map_capture_error)?;
    let disk = disk_value(paths, config);
    let data = if json_mode {
        json!({ "plan": plan, "policy": policy_value(&policy, origin), "disk": disk })
    } else {
        Value::String(text(&plan, origin, &disk))
    };
    Ok(CommandOutput {
        command: "sync.plan".to_owned(),
        data,
    })
}

fn text(plan: &CapturePlan, origin: Origin, disk: &Value) -> String {
    let mut out = String::new();
    let window = match plan.policy.since {
        Some(since) => format!(
            "sessions changed since {} ({})",
            since.format("%Y-%m-%d %H:%M UTC"),
            match origin {
                Origin::Default => "the first-run window",
                Origin::Config => "memoar policy",
                Origin::Flag => "--since",
            }
        ),
        None => "every session, however old".to_owned(),
    };
    let _ = writeln!(out, "Capture plan: {window}");
    for (name, globs) in [
        ("Include", &plan.policy.include),
        ("Exclude", &plan.policy.exclude),
    ] {
        if !globs.is_empty() {
            let _ = writeln!(out, "{name}: {}", globs.join(", "));
        }
    }
    let _ = writeln!(
        out,
        "Disk: {}",
        disk["detail"].as_str().unwrap_or("unknown")
    );
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "{:<16} {:>20} {:>20} {:>20} {:>20} {:>20}",
        "source", "found", "to capture", "already queued", "older", "excluded"
    );
    for source in &plan.sources {
        let _ = writeln!(out, "{}", row(&source.source, &source.counts));
    }
    let _ = writeln!(out, "{}", row("total", &plan.totals));
    for source in &plan.sources {
        let _ = writeln!(out, "\n{} by project, largest first:", source.source);
        for project in source.projects.iter().take(PROJECTS_SHOWN) {
            let _ = writeln!(out, "  {}", project.workspace);
            let _ = writeln!(out, "  {}", row("", &project.counts));
        }
        let more = source.projects.len().saturating_sub(PROJECTS_SHOWN);
        if more > 0 {
            let _ = writeln!(
                out,
                "  and {more} more (memoar --json sync --plan lists all)"
            );
        }
    }
    let older = plan.totals.too_old;
    if older.files > 0 {
        let _ = writeln!(
            out,
            "\n{} older sessions ({}) are left out. memoar sync --since all takes them once, memoar policy --since all keeps taking them.",
            older.files,
            human_bytes(older.bytes)
        );
    }
    let _ = writeln!(
        out,
        "memoar policy --exclude '<glob>' leaves out a workspace, such as '/private/tmp/**'."
    );
    out.trim_end().to_owned()
}

fn row(label: &str, counts: &PlanCounts) -> String {
    let cell = |tally: Tally| format!("{} ({})", tally.files, human_bytes(tally.bytes));
    format!(
        "{:<16} {:>20} {:>20} {:>20} {:>20} {:>20}",
        label,
        cell(counts.found),
        cell(counts.to_capture),
        cell(counts.queued),
        cell(counts.too_old),
        cell(counts.excluded)
    )
}
