//! Capturing and reporting, done by the same code the CLI runs.
//!
//! Everything here builds a `Cli` and calls `memoar_cli::execute`, rather than
//! reimplementing discovery, queueing or upload. A second implementation of
//! capture would be a second thing to keep true, and the two would drift the
//! first time either was fixed.
//!
//! Nothing here touches the UI. Every function blocks on disk or network, and
//! the window calls them on a background thread.

use std::sync::Mutex;

use memoar_cli::{Command, RedactionArgs, SourcesCommand, SyncArgs};
use serde::{Deserialize, Serialize};

use crate::failure::{Failure, FailureKind, classify_capture};
use crate::fields::{detected_sources, flag, number, text};
use crate::paths::{Paths, base_cli};

/// What the window shows, and nothing it cannot support.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// False until this machine has signed in, and the window asks for credentials.
    pub signed_in: bool,
    /// The archive this machine talks to. Kept when signed out, so signing in
    /// again starts from the address that was used last.
    pub endpoint: Option<String>,
    pub machine_id: Option<String>,
    /// Artifacts waiting in the local queue, which survives being offline.
    pub queued: Option<u64>,
    /// Artifacts the archive did not take yet, tried again on the next capture.
    pub retrying: Option<u64>,
    /// Everything this machine's queue has delivered, across every capture.
    pub uploaded_total: Option<u64>,
    /// The agents whose stores were found on this machine, by display name.
    pub sources: Vec<String>,
    pub last_sync_at: Option<String>,
    pub last_error: Option<Failure>,
    /// Sessions and memory files the last capture uploaded.
    pub last_uploaded: Option<u64>,
    pub last_memory_recorded: Option<u64>,
    /// What is masked before anything is hashed and uploaded.
    pub redaction: Option<Redaction>,
}

/// The three masks, as the window renders them.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Redaction {
    pub secrets: bool,
    pub email_addresses: bool,
    pub home_paths: bool,
}

/// The app's own record of how the last capture went.
///
/// Serializable so the window can keep it across restarts: "last captured"
/// should not read "never" because the app was relaunched.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub at: Option<String>,
    pub error: Option<Failure>,
    pub uploaded: Option<u64>,
    pub memory_recorded: Option<u64>,
}

#[derive(Debug, Default)]
pub struct State {
    last_run: Mutex<LastRun>,
}

impl State {
    #[must_use]
    pub fn with_last_run(run: LastRun) -> Self {
        Self {
            last_run: Mutex::new(run),
        }
    }

    #[must_use]
    pub fn last_run(&self) -> LastRun {
        self.lock().clone()
    }

    /// Drops the record, as a new sign-in does: a revocation that applied to
    /// the old key says nothing about the new one.
    pub fn forget(&self) {
        *self.lock() = LastRun::default();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LastRun> {
        self.last_run
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn redaction_of(value: &serde_json::Value) -> Option<Redaction> {
    Some(Redaction {
        secrets: flag(value, &["redaction", "secrets"])?,
        email_addresses: flag(value, &["redaction", "emailAddresses"])?,
        home_paths: flag(value, &["redaction", "homePaths"])?,
    })
}

/// The endpoint `config.json` names, read without needing a credential.
fn configured_endpoint(paths: &Paths) -> Option<String> {
    let bytes = std::fs::read(paths.config_dir.join("config.json")).ok()?;
    let config: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    text(&config, &["endpoint"])
}

/// Reads what the archive connection looks like from here.
///
/// Absence is reported as absence: a machine that has never signed in says so
/// rather than showing zeros that look like a healthy idle state.
#[must_use]
pub fn status(paths: &Paths, state: &State) -> Status {
    let runtime = paths.runtime();
    let last = state.last_run();
    match memoar_cli::execute(&base_cli(Command::Status), &runtime) {
        Ok(output) => Status {
            signed_in: true,
            endpoint: text(&output.data, &["endpoint"]),
            machine_id: text(&output.data, &["machineId"]),
            queued: number(&output.data, &["queue", "pending"]),
            retrying: number(&output.data, &["queue", "retry"]),
            uploaded_total: number(&output.data, &["queue", "synced"]),
            sources: sources(paths),
            last_sync_at: last.at,
            last_error: last.error,
            last_uploaded: last.uploaded,
            last_memory_recorded: last.memory_recorded,
            redaction: redaction_of(&output.data),
        },
        // `status` fails when there is no configuration or credential, which
        // is the ordinary state of a machine nobody has connected: not an
        // error to put in front of somebody.
        Err(_) => Status {
            signed_in: false,
            endpoint: configured_endpoint(paths),
            last_sync_at: last.at,
            last_error: last.error,
            ..Status::default()
        },
    }
}

fn sources(paths: &Paths) -> Vec<String> {
    let command = Command::Sources {
        command: SourcesCommand::List,
    };
    memoar_cli::execute(&base_cli(command), &paths.runtime())
        .map(|output| detected_sources(&output.data))
        .unwrap_or_default()
}

/// Changes what is masked before upload, after sign-in.
///
/// # Errors
/// When this machine has no configuration to change yet.
pub fn set_redaction(
    paths: &Paths,
    state: &State,
    redaction: Redaction,
) -> Result<Status, Failure> {
    let command = Command::Redaction(RedactionArgs {
        secrets: Some(redaction.secrets),
        email_addresses: Some(redaction.email_addresses),
        home_paths: Some(redaction.home_paths),
    });
    memoar_cli::execute(&base_cli(command), &paths.runtime()).map_err(|error| {
        Failure::new(
            FailureKind::Other,
            error.message.clone(),
            error.message.clone(),
        )
    })?;
    Ok(status(paths, state))
}

/// Captures and uploads once, recording the outcome for the window.
///
/// # Errors
/// When the capture fails. The failure is also kept in `state`, so the window
/// can show it rather than a spinner that stops.
pub fn sync_now(paths: &Paths, state: &State, now: &str) -> Result<Status, Failure> {
    let command = Command::Sync(SyncArgs {
        watch: false,
        interval_seconds: 60,
        debounce_seconds: 2,
        max_cycles: 0,
    });
    let outcome = memoar_cli::execute(&base_cli(command), &paths.runtime());
    let endpoint = configured_endpoint(paths).unwrap_or_default();
    let result = outcome
        .as_ref()
        .map(|_| ())
        .map_err(|error| classify_capture(error, &endpoint));
    {
        let mut last = state.lock();
        last.at = Some(now.to_owned());
        match &outcome {
            Ok(output) => {
                last.error = None;
                last.uploaded = number(&output.data, &["sync", "uploaded"]);
                last.memory_recorded = number(&output.data, &["memory", "recorded"]);
            }
            Err(_) => last.error = result.clone().err(),
        }
    }
    result?;
    Ok(status(paths, state))
}

/// The API endpoint without its `/v1`: where the web application lives when it
/// is served from the same origin as the API.
#[must_use]
pub fn archive_url(endpoint: &str) -> String {
    endpoint
        .trim()
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/')
        .to_owned()
}

/// Where "Open web app" goes: the address the person gave, else the API's
/// origin.
///
/// The API cannot be relied on to serve the web application. In the Compose
/// deployment they are separate services on separate ports, and the old
/// derivation alone opened the API's root, which answers 404.
#[must_use]
pub fn web_app_url(configured: &str, endpoint: &str) -> String {
    let configured = configured.trim().trim_end_matches('/');
    if configured.is_empty() {
        archive_url(endpoint)
    } else {
        configured.to_owned()
    }
}

/// The tests live beside this file, to keep each under the size rule.
#[cfg(test)]
#[path = "capture_tests.rs"]
pub(crate) mod tests;
