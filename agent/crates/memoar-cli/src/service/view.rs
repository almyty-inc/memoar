//! The service as `status`, `doctor` and `logout` see it.

use chrono::Utc;
use memoar_daemon::{OfflineQueue, QueueActivity};
use serde_json::{Value, json};

use super::spec::load_record;
use super::{manager, query, remove};
use crate::capture_state;
use crate::config::RuntimePaths;
use crate::health::{Health, HealthInputs, ServiceView, assess};
use crate::lock::sync_holder;

/// Whether capture is running for this configuration, and the service's part
/// in it. Reads the queue without changing it, and asks the service manager
/// only when a service was installed for this configuration.
pub(crate) fn background(paths: &RuntimePaths) -> (Health, Value) {
    let activity = OfflineQueue::open(&paths.queue_file())
        .and_then(|queue| queue.activity())
        .unwrap_or_default();
    background_with(paths, &activity)
}

pub(crate) fn background_with(paths: &RuntimePaths, activity: &QueueActivity) -> (Health, Value) {
    let record = load_record(paths);
    let (view, service) = match &record {
        None => (
            ServiceView::NotInstalled,
            json!({ "installed": false, "manager": manager() }),
        ),
        Some(record) => {
            let state = query(&record.name, paths);
            let (running, detail) = if !state.defined && !state.loaded && state.running.is_some() {
                (
                    Some(false),
                    format!("{} no longer has its definition", manager()),
                )
            } else {
                (state.running, state.detail.clone())
            };
            (
                ServiceView::Installed {
                    name: record.name.clone(),
                    running,
                    detail: detail.clone(),
                },
                json!({
                    "installed": true,
                    "name": record.name,
                    "manager": manager(),
                    "running": running,
                    "pid": state.pid,
                    "detail": detail,
                }),
            )
        }
    };
    let holder = sync_holder(paths);
    let state = capture_state::load(paths);
    let health = assess(&HealthInputs {
        now: Utc::now(),
        service: &view,
        sync_running: holder.is_some(),
        state: state.as_ref(),
        activity,
    });
    (health, service)
}

/// `logout` stops capture with the credential: a service left installed would
/// start at the next login and stop at once for want of one.
pub(crate) fn remove_for_logout(paths: &RuntimePaths, keep: bool) -> Value {
    let Some(record) = load_record(paths) else {
        return Value::Null;
    };
    if keep {
        return json!({
            "removed": false,
            "name": record.name,
            "detail": "kept, as asked. It stops at its next start until you sign in again.",
        });
    }
    match remove(&record.name, paths) {
        Ok(_) => json!({ "removed": true, "name": record.name }),
        Err(error) => json!({
            "removed": false,
            "name": record.name,
            "detail": error.message,
            "hint": "Run `memoar service uninstall` to remove it.",
        }),
    }
}
