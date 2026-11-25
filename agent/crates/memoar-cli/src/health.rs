//! Whether anything is capturing on this machine, and if not, why.
//!
//! `status` reported the queue counts and nothing about whether a capture was
//! running at all. When the terminal holding `sync --watch` closed, the
//! counts went on looking ordinary, and two months of sessions never reached
//! the archive. This decides, from what is on disk and what the service
//! manager says, one of five states and a sentence that says what to do.
//!
//! Pure on purpose: every input is handed in, so each verdict is a unit test.

use chrono::{DateTime, Duration, Utc};
use memoar_daemon::QueueActivity;
use serde::Serialize;

use crate::capture_state::CaptureState;

/// How long artifacts may wait with nothing uploaded before capture counts as
/// stopped, whatever else claims to be running.
pub(crate) const STALE_AFTER: Duration = Duration::hours(24);

/// What the platform's service manager says about the installed service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ServiceView {
    NotInstalled,
    Installed {
        name: String,
        /// `None` when the manager could not be asked.
        running: Option<bool>,
        detail: String,
    },
}

pub(crate) struct HealthInputs<'a> {
    pub(crate) now: DateTime<Utc>,
    pub(crate) service: &'a ServiceView,
    /// A process holds this data directory's sync lock: a watch, a one-off
    /// sync, or the service's own watch.
    pub(crate) sync_running: bool,
    pub(crate) state: Option<&'a CaptureState>,
    pub(crate) activity: &'a QueueActivity,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Health {
    /// `running`, `retrying`, `stale`, `stopped` or `not_running`.
    pub(crate) state: &'static str,
    pub(crate) ok: bool,
    pub(crate) summary: String,
    pub(crate) hint: Option<String>,
    pub(crate) last_upload_at: Option<DateTime<Utc>>,
    pub(crate) waiting: u64,
    pub(crate) oldest_waiting_at: Option<DateTime<Utc>>,
}

const INSTALL_HINT: &str = "Run `memoar service install` to keep capture running in the background, and `memoar service logs` to see what it last did.";

pub(crate) fn assess(inputs: &HealthInputs) -> Health {
    let activity = inputs.activity;
    let last_upload = latest(
        inputs.state.and_then(|state| state.last_success_at),
        parse(activity.last_synced_at.as_deref()),
    );
    let oldest = parse(activity.oldest_waiting_at.as_deref()).filter(|_| activity.waiting > 0);
    let older_than_limit = |at: DateTime<Utc>| inputs.now - at > STALE_AFTER;
    let overdue = oldest.is_some_and(older_than_limit) && last_upload.is_none_or(older_than_limit);
    let service_running = matches!(
        inputs.service,
        ServiceView::Installed {
            running: Some(true),
            ..
        }
    );
    let capturing = inputs.sync_running || service_running;
    let health = |state: &'static str, ok: bool, summary: String, hint: Option<String>| Health {
        state,
        ok,
        summary,
        hint,
        last_upload_at: last_upload,
        waiting: activity.waiting,
        oldest_waiting_at: oldest,
    };
    let backlog = || backlog_sentence(activity.waiting, last_upload);
    let last_error = inputs.state.and_then(|state| state.last_error.as_ref());

    if !capturing {
        if let Some(stopped) = inputs.state.and_then(|state| state.stopped.as_ref()) {
            return health(
                "stopped",
                false,
                format!(
                    "background capture stopped: {} ({}){}",
                    stopped.message,
                    stopped.at.format("%Y-%m-%d %H:%M UTC"),
                    backlog()
                ),
                Some(format!(
                    "{} Then run `memoar service install` to start background capture again.",
                    stopped.hint
                )),
            );
        }
        if let ServiceView::Installed {
            name,
            running: Some(false),
            detail,
        } = inputs.service
        {
            return health(
                "stopped",
                false,
                format!(
                    "background capture stopped: the {name} service is installed but not running{}{}",
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!(" ({detail})")
                    },
                    backlog()
                ),
                Some("Run `memoar service logs` to see why, and `memoar service install` to start it again.".to_owned()),
            );
        }
        if let ServiceView::Installed { running: None, .. } = inputs.service {
            // The manager could not be asked. Only the queue can speak.
            if overdue {
                return health(
                    "stale",
                    false,
                    format!(
                        "background capture stopped: {}",
                        backlog().trim_start_matches(". ")
                    ),
                    Some(INSTALL_HINT.to_owned()),
                );
            }
            return health(
                "running",
                true,
                "background capture is installed, and its service manager could not be asked whether it is running".to_owned(),
                None,
            );
        }
        return health(
            "not_running",
            false,
            format!(
                "background capture is not running: no service is installed for this configuration and no sync holds its queue, so new sessions are not captured{}",
                backlog()
            ),
            Some(INSTALL_HINT.to_owned()),
        );
    }
    if overdue {
        return health(
            "stale",
            false,
            format!(
                "background capture stopped uploading{}{}",
                backlog(),
                last_error
                    .map(|error| format!(". Last error: {}", error.message))
                    .unwrap_or_default()
            ),
            Some(
                last_error
                    .map(|error| error.hint.clone())
                    .unwrap_or_else(|| {
                        "Run `memoar doctor` to see what the archive says.".to_owned()
                    }),
            ),
        );
    }
    if let Some(error) = last_error {
        return health(
            "retrying",
            true,
            format!(
                "background capture is running and retrying: {}",
                error.message
            ),
            Some(error.hint.clone()),
        );
    }
    health(
        "running",
        true,
        match last_upload {
            Some(at) => format!(
                "background capture is running. Last upload {}",
                at.format("%Y-%m-%d %H:%M UTC")
            ),
            None => "background capture is running".to_owned(),
        },
        None,
    )
}

/// ". 12 artifacts wait to upload, nothing uploaded since ..." or empty.
fn backlog_sentence(waiting: u64, last_upload: Option<DateTime<Utc>>) -> String {
    if waiting == 0 {
        return String::new();
    }
    let since = match last_upload {
        Some(at) => format!("nothing uploaded since {}", at.format("%Y-%m-%d %H:%M UTC")),
        None => "nothing uploaded yet".to_owned(),
    };
    format!(". {waiting} artifacts wait to upload, {since}")
}

fn parse(value: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

fn latest(left: Option<DateTime<Utc>>, right: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}
