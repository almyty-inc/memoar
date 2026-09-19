use chrono::Utc;
use memoar_connectors::{OperatingSystem, SOURCES};
use memoar_daemon::{
    CaptureSummary, OfflineQueue, SyncEngine, capture_sources_with_redaction, memory::MemorySync,
};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use crate::CommandOutput;
use crate::api::ApiClient;
use crate::args::SyncArgs;
use crate::config::{Config, RuntimePaths, load_config, load_credential};
use crate::credential::Credential;
use crate::error::{AppError, map_capture_error, map_queue_error, map_sync_error};
use crate::machine::{capture_transport, issue_machine_token, patch_machine_state};
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
    let credential = load_credential(paths)?;
    let queue = OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    let enabled = enabled_sources(&config);
    let captured = capture_sources_with_redaction(
        &queue,
        &paths.home,
        OperatingSystem::current(),
        &enabled,
        config.redaction,
    )
    .map_err(map_capture_error)?;
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
    };
    if args.watch {
        return watch(args, &mut sweep, captured);
    }
    let last = sync_pending(&mut sweep, captured)?;
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
    patch_machine_state(&api, config, paths)?;
    let (token, expires_at) = issue_machine_token(&api, &config.machine_id)?;
    let report = SyncEngine::new(capture_transport(
        config,
        credential,
        &token,
        expires_at.as_deref(),
    ))
    .sync(queue, &config.machine_id)
    .map_err(map_sync_error)?;
    // The instruction files the agents on this machine read, for the projects
    // this account already has sessions in. They are not transcripts and do not
    // go through the queue: what matters is whether the text changed.
    // With the redaction the user asked for. It was applied to transcripts and
    // not to these — so somebody who ran `memoar login --redact-secrets` had
    // their sessions scrubbed and their `~/.claude/CLAUDE.md`, every project
    // `AGENTS.md` and every `~/.claude/projects/*/memory/*.md` uploaded byte for
    // byte, which are the files a connection string actually gets pasted into.
    // The sweep is handed in rather than built here so its "this file has not
    // changed" cache survives a watch cycle; building a new one each pass
    // re-uploaded every instruction file on this machine every interval.
    let memory = sweep.memory.run(
        &capture_transport(config, credential, &token, expires_at.as_deref()),
        &paths.home,
        &archived_workspaces(&api, &paths.home),
        &config.machine_id,
        &Utc::now().to_rfc3339(),
    );
    // `skipped` is named, not just counted: a file redaction could not be
    // applied to stays on this machine, and you are entitled to know which.
    //
    // `memoryRefused` is the same thing for instruction files, and is a count
    // rather than a list because the report the daemon returns carries only a
    // number. It sits here, beside `skipped`, rather than buried in the memory
    // block: a file that stayed behind is not a detail. Naming them needs
    // `MemoryReport` to carry the paths, which is the daemon's to change.
    Ok(json!({
        "captured": captured.captured,
        "skipped": captured.skipped.iter().map(|path| path.display().to_string()).collect::<Vec<_>>(),
        "memoryRefused": memory.refused,
        "sync": report,
        "memory": memory,
    }))
}

/// The project roots this account has archived sessions in, kept inside the
/// home this machine captures from.
///
/// Which directories are projects is not something the agent can know by
/// looking: a home directory is full of checkouts nobody works in. The archive
/// already knows, because a transcript names the directory it was recorded in,
/// so memory files are captured for the projects actually being worked on and
/// nowhere else. A failure here means no project files this sweep, not a failed
/// sync — the transcripts are the point.
///
/// But a `workspace` is a string the server chose, and it was being used as a
/// local read root on the strength of `is_absolute() && is_dir()` alone. An
/// archive that was compromised, or simply wrong, could answer
/// `"workspace": "/Users/someone-else"` and this machine would read instruction
/// files out of it and upload them. The server does not get to choose which
/// local files the client reads: the capture home is the only directory the
/// person running the agent nominated, so a root outside it is discarded.
/// Both sides are canonicalised first, because `..` and a symlink pointing out
/// of the home are the same trick spelled differently.
fn archived_workspaces(api: &ApiClient, home: &Path) -> Vec<PathBuf> {
    let Ok(response) = api.get_query("/sessions", &[("limit", "100".to_owned())]) else {
        return Vec::new();
    };
    let Ok(home) = home.canonicalize() else {
        return Vec::new();
    };
    let mut roots: BTreeSet<PathBuf> = BTreeSet::new();
    for session in response["items"].as_array().unwrap_or(&Vec::new()) {
        let Some(workspace) = session["workspace"].as_str() else {
            continue;
        };
        let path = PathBuf::from(workspace);
        // Canonicalising answers "does it exist" and "where does it really
        // lead" in one step; an absolute path is still required first so a
        // relative one is never resolved against this process's directory.
        if !path.is_absolute() {
            continue;
        }
        let Ok(path) = path.canonicalize() else {
            continue;
        };
        if path.is_dir() && path.starts_with(&home) {
            roots.insert(path);
        }
    }
    roots.into_iter().collect()
}
