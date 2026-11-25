use chrono::Utc;
use memoar_connectors::SOURCES;
use memoar_daemon::{
    CapturePolicy, CaptureSummary, OfflineQueue, SyncEngine, check_space, memory::MemorySync,
};
use serde_json::{Value, json};
use std::collections::HashSet;

use crate::CommandOutput;
use crate::api::ApiClient;
use crate::args::SyncArgs;
use crate::capture_policy::{Origin, disk_json, effective_policy, space_floor};
use crate::capture_step::{backfill_value, capture_step};
use crate::config::{Config, RuntimePaths, load_config, load_credential};
use crate::credential::Credential;
use crate::error::{AppError, map_queue_error, map_sync_error};
use crate::lock::acquire_sync_lock;
use crate::machine::{
    capture_transport, issue_machine_token, machine_refusal, patch_machine_state,
};
use crate::plan_report::plan;
use crate::progress::{ProgressMode, ProgressPrinter};
use crate::sync_archive::{archived_workspaces, machine_token_refusal};
use crate::watch::watch;

pub(crate) fn sync(
    args: &SyncArgs,
    json_mode: bool,
    paths: &RuntimePaths,
) -> Result<CommandOutput, AppError> {
    if args.watch && json_mode {
        return Err(AppError::usage("--watch cannot be combined with --json"));
    }
    let config = load_config(paths)?;
    let enabled = enabled_sources(&config);
    if args.plan {
        return plan(args, json_mode, paths, &config, &enabled);
    }
    let credential = load_credential(paths)?;
    // Held until this function returns, a watch included.
    let _lock = acquire_sync_lock(paths)?;
    let floor = space_floor(&config);
    // Before anything is written: on a full disk a queue that does not exist
    // yet is not created. One that exists is opened, because uploading what
    // it holds is how its copies are given back.
    let space = check_space(&paths.data_dir, floor, 0).map_err(map_queue_error)?;
    if !space.ok && !paths.queue_file().exists() {
        return Err(AppError::disk_low(format!(
            "Capture did not start: {} has {} bytes free and capture keeps {} free.",
            space.path.display(),
            space.available_bytes,
            space.floor_bytes
        )));
    }
    let queue = OfflineQueue::open(&paths.queue_file())
        .map_err(map_queue_error)?
        .with_space_floor(floor);
    let (policy, origin) = effective_policy(&config, Some(&queue), args.since.as_deref())?;
    let captured = capture_step(&queue, paths, &config, &enabled, &policy)?;
    let mode = ProgressMode::for_command(json_mode);
    if let Some(refused) = &captured.refused
        && mode != ProgressMode::Silent
    {
        eprintln!("memoar: {}", refused.message);
    }
    let mut sweep = Sweep {
        queue: &queue,
        config: &config,
        credential: &credential,
        paths,
        enabled,
        // One sweep for the life of the command. It remembers which instruction
        // files it has already sent, and a fresh one each cycle remembers
        // nothing — which, now that a watch survives its own failures, is every
        // instruction file on the machine re-uploaded every interval for as
        // long as the laptop is on.
        memory: MemorySync::with_redaction(config.redaction),
        policy,
        origin,
        workers: usize::from(args.workers),
        uploads_per_minute: args.uploads_per_minute,
        progress: mode,
    };
    if args.watch {
        return watch(args, &mut sweep, captured.summary);
    }
    let last = sync_pending(&mut sweep, captured.summary)?;
    crate::capture_state::record_sync(paths);
    if let (Some(hint), false) = (
        last["backfill"]["hint"].as_str(),
        mode == ProgressMode::Silent,
    ) {
        eprintln!("memoar: {hint}");
    }
    // Uploaded what was already queued, and still says capture was refused:
    // a sync that read nothing new did not do what was asked.
    if let Some(refused) = captured.refused {
        return Err(refused);
    }
    Ok(CommandOutput {
        command: "sync".to_owned(),
        data: last,
    })
}

/// What every cycle of a sync needs, assembled once.
///
/// Gathered into one value because a watch hands the same things to every
/// cycle, and because the memory sweep in particular has to be the same one
/// each time: it is what remembers which instruction files have not changed.
pub(crate) struct Sweep<'a> {
    pub(crate) queue: &'a OfflineQueue,
    pub(crate) config: &'a Config,
    pub(crate) credential: &'a Credential,
    pub(crate) paths: &'a RuntimePaths,
    pub(crate) enabled: HashSet<String>,
    pub(crate) memory: MemorySync,
    pub(crate) policy: CapturePolicy,
    pub(crate) origin: Origin,
    pub(crate) workers: usize,
    pub(crate) uploads_per_minute: u32,
    pub(crate) progress: ProgressMode,
}

fn enabled_sources(config: &Config) -> HashSet<String> {
    SOURCES
        .iter()
        .filter(|source| !config.disabled_sources.contains(source.id))
        .map(|source| source.id.to_owned())
        .collect()
}

pub(crate) fn sync_pending(sweep: &mut Sweep, captured: CaptureSummary) -> Result<Value, AppError> {
    let Sweep {
        queue,
        config,
        credential,
        paths,
        ..
    } = *sweep;
    let api = ApiClient::new(&config.endpoint, Some(credential));
    patch_machine_state(&api, config, paths)
        .map_err(|error| machine_refusal(&api, &config.machine_id, error))?;
    let (token, expires_at) = issue_machine_token(&api, &config.machine_id)
        .map_err(|error| machine_refusal(&api, &config.machine_id, error))?;
    let mut printer = ProgressPrinter::new(sweep.progress);
    let drained = SyncEngine::new(capture_transport(
        config,
        credential,
        &token,
        expires_at.as_deref(),
    ))
    .with_workers(sweep.workers)
    .with_upload_rate(sweep.uploads_per_minute)
    .with_requeue(config.redaction)
    .drain_with_progress(queue, &config.machine_id, &mut |progress| {
        printer.update(progress);
    });
    printer.finish();
    let report = drained.map_err(|error| machine_token_refusal(map_sync_error(error)))?;
    // The instruction files the agents on this machine read, for the projects
    // this account already has sessions in, with the redaction the user asked
    // for. They are not transcripts and do not go through the queue: what
    // matters is whether the text changed. The sweep is handed in rather than
    // built here so its "this file has not changed" cache survives a watch
    // cycle.
    let memory = sweep.memory.run(
        &capture_transport(config, credential, &token, expires_at.as_deref()),
        &paths.home,
        &archived_workspaces(&api, &paths.home),
        &config.machine_id,
        &Utc::now().to_rfc3339(),
    );
    let disk = check_space(
        &paths.data_dir,
        crate::capture_policy::space_floor(config),
        0,
    )
    .map(|check| disk_json(&check))
    .unwrap_or(Value::Null);
    // `skipped` is named, not just counted: a file redaction could not be
    // applied to stays on this machine, and you are entitled to know which.
    // `memoryRefused` is the same thing for instruction files, as a count
    // because the report the daemon returns carries only a number.
    Ok(json!({
        "captured": captured.captured,
        "skipped": captured.skipped.iter().map(|path| path.display().to_string()).collect::<Vec<_>>(),
        "memoryRefused": memory.refused,
        "backfill": backfill_value(&captured, &sweep.policy, sweep.origin),
        "sync": report,
        "memory": memory,
        "disk": disk,
    }))
}
