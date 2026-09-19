use memoar_connectors::{OperatingSystem, SOURCES, discover};
use memoar_daemon::OfflineQueue;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use crate::CommandOutput;
use crate::api::ApiClient;
use crate::config::{RuntimePaths, load_config, load_credential};
use crate::error::{AppError, map_queue_error};
use crate::machine::{issue_machine_token, patch_machine_state, verify_machine};

pub(crate) fn status(paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let config = load_config(paths)?;
    let credential = load_credential(paths)?;
    let queue = OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    let counts = queue.counts().map_err(map_queue_error)?;
    let discovered = discover(&paths.home, OperatingSystem::current());
    Ok(CommandOutput {
        command: "status".to_owned(),
        data: json!({
            "initialized": true,
            "credentialsConfigured": !credential.secret().is_empty(),
            "endpoint": config.endpoint,
            "machineId": config.machine_id,
            "queue": counts,
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
fn skipped_symlinks(home: &Path) -> Vec<Value> {
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

/// Tools whose uploads the archive could not turn into a session.
///
/// A failure to ask is not a failure of the machine: `doctor` reports what it
/// can reach, and an archive that does not answer this yet leaves the check
/// silent rather than red.
fn unparsed_sources(api: &ApiClient) -> Vec<(String, u64)> {
    let Ok(body) = api.get("/ingest/unparsed") else {
        return Vec::new();
    };
    body.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some((
                        item.get("source")?.as_str()?.to_owned(),
                        item.get("artifacts")?.as_u64()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn doctor(paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let config = load_config(paths)?;
    let credential = load_credential(paths)?;
    let queue = OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    let database_ok = queue.integrity_check().map_err(map_queue_error)?;
    let api = ApiClient::new(&config.endpoint, Some(&credential));
    verify_machine(&api, &config.machine_id)?;
    let (machine_token, _) = issue_machine_token(&api, &config.machine_id)?;
    patch_machine_state(&api, &config, paths)?;
    let symlinks = skipped_symlinks(&paths.home);
    let unparsed = unparsed_sources(&api);
    let checks = vec![
        json!({ "name": "contract_version", "ok": config.contract_version == memoar_canonical::CONTRACT_VERSION, "detail": config.contract_version }),
        json!({ "name": "queue_integrity", "ok": database_ok, "detail": paths.queue_file() }),
        json!({ "name": "credentials", "ok": !credential.secret().is_empty(), "detail": "credential store contains a token" }),
        json!({ "name": "source_table", "ok": !SOURCES.is_empty(), "detail": format!("{} sources", SOURCES.len()) }),
        json!({ "name": "api_reachable", "ok": true, "detail": config.endpoint }),
        json!({ "name": "machine_registered", "ok": true, "detail": config.machine_id }),
        json!({ "name": "machine_token", "ok": !machine_token.is_empty(), "detail": "machine token issued" }),
        // A source can be detected and still be captured from not at all: a
        // symlinked store is skipped by discovery in silence. Not ok — files
        // this machine believes it is archiving are being dropped.
        json!({
            "name": "source_symlinks",
            "ok": symlinks.is_empty(),
            "detail": if symlinks.is_empty() {
                "no source is behind a symlink".to_owned()
            } else {
                format!("{} skipped: {}", symlinks.len(), symlink_summary(&symlinks))
            },
            "skipped": symlinks
        }),
        // Bytes the archive kept and could not read. Keeping them is the right
        // thing — a parser written later can still use them — but a tool that
        // produces only these is capturing the wrong files, which is the one
        // way capture fails without failing. Two sources were found doing it,
        // one of them archiving an editor's terminal history rather than its
        // conversations, for as long as its pattern had existed.
        json!({
            "name": "artifacts_parsed",
            "ok": unparsed.is_empty(),
            "detail": if unparsed.is_empty() {
                "everything uploaded became a session".to_owned()
            } else {
                unparsed
                    .iter()
                    .map(|(source, count)| format!("{source}: {count}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            },
            "unparsed": unparsed.iter().map(|(source, count)| json!({ "source": source, "artifacts": count })).collect::<Vec<_>>()
        }),
    ];
    let ok = checks.iter().all(|check| check["ok"] == Value::Bool(true));
    Ok(CommandOutput {
        command: "doctor".to_owned(),
        data: json!({ "ok": ok, "checks": checks }),
    })
}

/// Names the sources rather than the count, so the sentence is actionable.
fn symlink_summary(symlinks: &[Value]) -> String {
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
