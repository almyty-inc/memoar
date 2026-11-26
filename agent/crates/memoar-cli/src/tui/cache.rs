//! The last session list and machine names, kept in the data directory so
//! the TUI opens with something to show when the archive cannot be reached.
//!
//! Owner-only files beside the capture queue, which already holds whole
//! transcripts. A cache that cannot be written or read is not an error: the
//! TUI simply starts empty and waits for the archive.

use chrono::Utc;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::config::{RuntimePaths, atomic_replace, load_config};

fn directory(paths: &RuntimePaths) -> PathBuf {
    paths.data_dir.join("tui")
}

fn sessions_file(paths: &RuntimePaths) -> PathBuf {
    directory(paths).join("sessions.json")
}

fn machines_file(paths: &RuntimePaths) -> PathBuf {
    directory(paths).join("machines.json")
}

fn write(path: PathBuf, value: &Value) {
    if let Ok(bytes) = serde_json::to_vec(value) {
        let _ = atomic_replace(&path, &bytes, 0o600);
    }
}

fn read(path: PathBuf) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Which sign-in a cache belongs to. A cache written before a `logout` and a
/// `login` to another archive or account is not shown for the new one.
fn owner(paths: &RuntimePaths) -> Option<String> {
    let config = load_config(paths).ok()?;
    Some(format!("{} {}", config.endpoint, config.machine_id))
}

fn read_owned(path: PathBuf, paths: &RuntimePaths) -> Option<Value> {
    let cached = read(path)?;
    (cached.get("owner")?.as_str()? == owner(paths)?).then_some(cached)
}

pub(crate) fn save_sessions(paths: &RuntimePaths, page: &Value) {
    write(
        sessions_file(paths),
        &json!({ "owner": owner(paths), "savedAt": Utc::now().to_rfc3339(), "page": page }),
    );
}

/// The cached first page, and when it was saved.
pub(crate) fn load_sessions(paths: &RuntimePaths) -> Option<(Value, String)> {
    let mut cached = read_owned(sessions_file(paths), paths)?;
    let saved_at = cached.get("savedAt")?.as_str()?.to_owned();
    Some((cached.get_mut("page")?.take(), saved_at))
}

pub(crate) fn save_machines(paths: &RuntimePaths, names: &HashMap<String, String>) {
    write(
        machines_file(paths),
        &json!({ "owner": owner(paths), "names": names }),
    );
}

pub(crate) fn load_machines(paths: &RuntimePaths) -> HashMap<String, String> {
    read_owned(machines_file(paths), paths)
        .and_then(|cached| serde_json::from_value(cached.get("names")?.clone()).ok())
        .unwrap_or_default()
}
