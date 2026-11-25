use memoar_connectors::{OperatingSystem, discover};
use memoar_daemon::OfflineQueue;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use crate::CommandOutput;
use crate::capture_policy::{disk_value, effective_policy, policy_value};
use crate::config::{RuntimePaths, load_config, load_credential};
use crate::error::{AppError, map_queue_error};
use crate::service::background_with;

pub(crate) fn status(paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let config = load_config(paths)?;
    let credential = load_credential(paths)?;
    let queue = OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    let counts = queue.counts().map_err(map_queue_error)?;
    let activity = queue.activity().map_err(map_queue_error)?;
    let (policy, origin) = effective_policy(&config, Some(&queue), None)?;
    drop(queue);
    let (health, service) = background_with(paths, &activity);
    let discovered = discover(&paths.home, OperatingSystem::current());
    Ok(CommandOutput {
        command: "status".to_owned(),
        data: json!({
            // Whether anything is capturing, first in the report: a queue
            // that looks ordinary says nothing about whether it still moves.
            "backgroundCapture": health,
            "service": service,
            "initialized": true,
            "credentialsConfigured": !credential.secret().is_empty(),
            "endpoint": config.endpoint,
            "machineId": config.machine_id,
            "queue": counts,
            "waitingBytes": activity.waiting_bytes,
            // Whether capture has room to work. `ok: false` means it reads
            // nothing new until space is freed.
            "disk": disk_value(paths, &config),
            "capturePolicy": policy_value(&policy, origin),
            "redaction": config.redaction,
            "detectedSources": discovered.iter().filter(|source| source.detected).count(),
            "sourceCount": discovered.len(),
            // Detected and readable are not the same thing, and this used to
            // report only the first. See `skipped_symlinks`.
            "skippedSymlinks": skipped_symlinks(&paths.home)
        }),
    })
}

/// How deep the symlink scan looks below a source's root.
///
/// The root itself and the directories directly under it, which is where the
/// two shapes that actually lose files live: a linked `~/.claude/projects`, and
/// a linked project directory inside a real one. Not the whole tree, because
/// `status` is polled every few seconds by the desktop app and walking every
/// session store on every poll would cost more than the answer is worth.
const SYMLINK_SCAN_DEPTH: u8 = 2;

/// The symlinks discovery walks past without a word, per source.
///
/// Discovery skips any entry that is a symlink, and says nothing about having
/// done it, while `detected` is answered by `Path::exists`, which follows them.
/// So a `~/.claude/projects` linked to an external volume is reported as a
/// detected source, captures nothing at all, and neither `sync` nor `doctor`
/// ever says why. Nothing here changes what is captured — the skipping belongs
/// to `memoar-connectors` — but the agent stops claiming a source it is not
/// reading.
pub(crate) fn skipped_symlinks(home: &Path) -> Vec<Value> {
    let mut reports = Vec::new();
    for source in discover(home, OperatingSystem::current()) {
        let mut links = Vec::new();
        for pattern in &source.paths {
            collect_skipped_symlinks(&literal_root(pattern), 0, &mut links);
        }
        links.sort();
        links.dedup();
        reports.extend(links.into_iter().map(|path| {
            json!({
                "source": source.id,
                "path": path,
                "detail": "a symlink: discovery does not follow it, so nothing under it is captured"
            })
        }));
    }
    reports
}

fn collect_skipped_symlinks(path: &Path, depth: u8, found: &mut Vec<PathBuf>) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() {
        found.push(path.to_path_buf());
        return;
    }
    if depth >= SYMLINK_SCAN_DEPTH || !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        collect_skipped_symlinks(&entry.path(), depth + 1, found);
    }
}

/// The part of a declared pattern that is a real path, which is the directory
/// discovery starts its walk from. The same cut `memoar-connectors` makes.
fn literal_root(pattern: &Path) -> PathBuf {
    let mut root = PathBuf::new();
    for component in pattern.components() {
        let text = component.as_os_str().to_string_lossy();
        if text.contains('*') || text.contains('<') || text.contains('{') {
            break;
        }
        root.push(component);
    }
    root
}

/// Names the sources rather than the count, so the sentence is actionable.
pub(crate) fn symlink_summary(symlinks: &[Value]) -> String {
    symlinks
        .iter()
        .map(|entry| {
            format!(
                "{} ({})",
                entry["path"].as_str().unwrap_or_default(),
                entry["source"].as_str().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}
