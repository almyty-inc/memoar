//! Signing in and capturing, done by the same code the CLI runs.
//!
//! Everything here builds a `Cli` and calls `memoar_cli::execute`, rather than
//! reimplementing login, discovery, queueing or upload. A second implementation
//! of capture would be a second thing to keep true, and the two would drift the
//! first time either was fixed.

use std::path::PathBuf;
use std::sync::Mutex;

use memoar_cli::{Cli, Command, LoginArgs, RuntimePaths, SyncArgs};
use serde::Serialize;
use serde_json::Value;

/// Where the app keeps configuration, queue and the home it captures from.
///
/// The same directories the CLI uses, so a machine that was set up with one is
/// already set up for the other, and the queue is never duplicated.
#[derive(Debug, Clone)]
pub struct Paths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub home: PathBuf,
}

impl Paths {
    /// # Errors
    /// When the home directory cannot be resolved.
    pub fn resolve() -> Result<Self, String> {
        let cli = base_cli(Command::Status);
        let paths = RuntimePaths::resolve(&cli).map_err(|error| error.message.clone())?;
        Ok(Self {
            config_dir: paths.config_dir,
            data_dir: paths.data_dir,
            home: paths.home,
        })
    }

    fn runtime(&self) -> RuntimePaths {
        RuntimePaths {
            config_dir: self.config_dir.clone(),
            data_dir: self.data_dir.clone(),
            home: self.home.clone(),
        }
    }
}

fn base_cli(command: Command) -> Cli {
    Cli {
        json: true,
        config_dir: None,
        data_dir: None,
        capture_home: None,
        command,
    }
}

/// What the window shows, and nothing it cannot support.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// False until this machine has signed in; the window asks for credentials.
    pub signed_in: bool,
    pub endpoint: Option<String>,
    pub machine_id: Option<String>,
    /// Artifacts waiting in the local queue, which survives being offline.
    pub queued: Option<u64>,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    /// Sessions and memory files the last sync uploaded.
    pub last_uploaded: Option<u64>,
    pub last_memory_recorded: Option<u64>,
}

/// The app's own record of how the last capture went.
#[derive(Debug, Default)]
pub struct LastRun {
    pub at: Option<String>,
    pub error: Option<String>,
    pub uploaded: Option<u64>,
    pub memory_recorded: Option<u64>,
}

#[derive(Debug, Default)]
pub struct State {
    pub last_run: Mutex<LastRun>,
}

fn number(value: &Value, path: &[&str]) -> Option<u64> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(key)?;
    }
    cursor.as_u64()
}

fn text(value: &Value, path: &[&str]) -> Option<String> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(key)?;
    }
    Some(cursor.as_str()?.to_owned())
}

/// Reads what the archive connection looks like from here.
///
/// Absence is reported as absence: a machine that has never signed in says so
/// rather than showing zeros that look like a healthy idle state.
#[must_use]
pub fn status(paths: &Paths, state: &State) -> Status {
    let runtime = paths.runtime();
    let last = state
        .last_run
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match memoar_cli::execute(&base_cli(Command::Status), &runtime) {
        Ok(output) => Status {
            signed_in: true,
            endpoint: text(&output.data, &["endpoint"]),
            machine_id: text(&output.data, &["machineId"]),
            queued: number(&output.data, &["queue", "pending"]),
            last_sync_at: last.at.clone(),
            last_error: last.error.clone(),
            last_uploaded: last.uploaded,
            last_memory_recorded: last.memory_recorded,
        },
        // `status` fails when there is no configuration yet, which is the
        // ordinary state of a machine nobody has connected — not an error to
        // put in front of somebody.
        Err(_) => Status {
            signed_in: false,
            last_error: last.error.clone(),
            ..Status::default()
        },
    }
}

/// # Errors
/// When the archive refuses the credentials or cannot be reached.
pub fn sign_in(
    paths: &Paths,
    endpoint: &str,
    email: &str,
    password: &str,
) -> Result<Status, String> {
    let command = Command::Login(LoginArgs {
        endpoint: endpoint.trim().to_owned(),
        email: Some(email.trim().to_owned()),
        password: Some(password.to_owned()),
        token: None,
        machine_id: None,
        // Off by default here as in the CLI: masking before upload is a choice
        // the archive cannot undo, so it is not made on somebody's behalf.
        redact_secrets: false,
        redact_email_addresses: false,
        redact_home_paths: false,
    });
    memoar_cli::execute(&base_cli(command), &paths.runtime())
        .map_err(|error| error.message.clone())?;
    Ok(status(paths, &State::default()))
}

/// Captures and uploads once, recording the outcome for the window.
///
/// # Errors
/// When the sync fails; the reason is kept so the window can show it rather
/// than a spinner that stops.
pub fn sync_now(paths: &Paths, state: &State, now: &str) -> Result<Status, String> {
    let command = Command::Sync(SyncArgs {
        watch: false,
        interval_seconds: 60,
        debounce_seconds: 2,
    });
    let outcome = memoar_cli::execute(&base_cli(command), &paths.runtime());
    {
        let mut last = state
            .last_run
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        last.at = Some(now.to_owned());
        match &outcome {
            Ok(output) => {
                last.error = None;
                last.uploaded = number(&output.data, &["sync", "uploaded"]);
                last.memory_recorded = number(&output.data, &["memory", "recorded"]);
            }
            Err(error) => last.error = Some(error.message.clone()),
        }
    }
    outcome.map_err(|error| error.message.clone())?;
    Ok(status(paths, state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch() -> (tempfile::TempDir, Paths) {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths {
            config_dir: temp.path().join("config"),
            data_dir: temp.path().join("data"),
            home: temp.path().join("home"),
        };
        (temp, paths)
    }

    #[test]
    fn a_machine_that_has_never_signed_in_says_so() {
        // Not an error dialog and not a page of zeros: an unconfigured machine
        // is the ordinary state of one nobody has connected yet, and the window
        // asks for credentials rather than reporting a healthy idle capture.
        let (_temp, paths) = scratch();

        let status = status(&paths, &State::default());

        assert!(!status.signed_in);
        assert!(status.endpoint.is_none());
        assert!(status.machine_id.is_none());
        assert!(status.queued.is_none());
    }

    #[test]
    fn a_failed_capture_is_remembered_and_shown() {
        // The window polls; if the failure were only returned to the caller of
        // sync_now it would vanish on the next refresh and the app would look
        // like it was capturing.
        let (_temp, paths) = scratch();
        let state = State::default();

        let failure = sync_now(&paths, &state, "2026-09-04T10:00:00Z");

        assert!(
            failure.is_err(),
            "syncing without a configured archive cannot succeed"
        );
        let status = status(&paths, &state);
        assert!(
            status.last_error.is_some(),
            "the reason is kept for the window"
        );
    }

    #[test]
    fn reads_only_the_fields_the_archive_sends() {
        // These paths are how the window learns what happened. Reading a field
        // that is not there must yield nothing rather than a zero that looks
        // like a measurement.
        let payload = json!({
            "endpoint": "https://archive.example/v1",
            "machineId": "0191cafe-0000-7000-8000-00000000d001",
            "queue": { "pending": 3, "retry": 0, "synced": 12 },
        });

        assert_eq!(
            text(&payload, &["endpoint"]).as_deref(),
            Some("https://archive.example/v1")
        );
        assert_eq!(number(&payload, &["queue", "pending"]), Some(3));
        assert_eq!(number(&payload, &["queue", "missing"]), None);
        assert_eq!(number(&payload, &["sync", "uploaded"]), None);
        assert_eq!(
            text(&payload, &["queue", "pending"]),
            None,
            "a number is not a string"
        );
    }

    #[test]
    fn uses_the_same_directories_the_cli_uses() {
        // A machine set up with one is already set up for the other, and the
        // offline queue is never duplicated between them.
        let (_temp, paths) = scratch();
        let runtime = paths.runtime();

        assert_eq!(runtime.config_dir, paths.config_dir);
        assert_eq!(runtime.data_dir, paths.data_dir);
        assert_eq!(runtime.home, paths.home);
    }
}
