//! `memoar service run`: what the installed service runs.
//!
//! It starts `memoar sync --watch` as a child, writes what the child prints to
//! the log, and decides from the child's exit code what happens next:
//!
//! - 2, 3 and 5 are usage, not signed in, and refused. Retrying cannot fix
//!   them, so the reason is recorded for `status` and the service exits 0,
//!   which every platform's service manager here treats as "leave it stopped".
//! - Anything else, a crash included, is retried after a backoff that doubles
//!   from ten seconds to five minutes and resets after a long healthy run.
//!
//! A child process rather than a loop in this one, for two reasons. A crash
//! in the watch is survived without the service manager's help, which Task
//! Scheduler does not reliably give. And the child is started from the
//! binary's path each time, so a binary upgraded in place is picked up: the
//! service notices the file changed and restarts the watch on it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use super::logfile::{LOG_CAP_BYTES, LogFile, cap_file};
use super::spec::{absolute_paths, directory_arguments, log_dir, log_file};
use crate::CommandOutput;
use crate::capture_state::{self, Failure};
use crate::config::{RuntimePaths, atomic_replace, create_private_dir};
use crate::error::{AppError, EXIT_NOT_INITIALIZED, EXIT_REFUSED, EXIT_USAGE};

pub(crate) const TERMINAL_EXIT_CODES: [i32; 3] = [
    EXIT_USAGE as i32,
    EXIT_NOT_INITIALIZED as i32,
    EXIT_REFUSED as i32,
];
const FIRST_BACKOFF: Duration = Duration::from_secs(10);
const BACKOFF_CEILING: Duration = Duration::from_secs(300);
/// A watch that ran this long before failing was healthy: start over at the
/// shortest wait.
const HEALTHY_RUN: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_secs(2);
const UPGRADE_CHECK: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceState {
    pub(crate) name: String,
    pub(crate) pid: u32,
    pub(crate) started_at: Option<DateTime<Utc>>,
    pub(crate) child_pid: Option<u32>,
    pub(crate) restarts: u32,
    pub(crate) last_exit: Option<Exit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Exit {
    pub(crate) at: DateTime<Utc>,
    pub(crate) code: Option<i32>,
    pub(crate) message: String,
}

pub(crate) fn state_file(paths: &RuntimePaths) -> PathBuf {
    paths.data_dir.join("service-state.json")
}

pub(crate) fn load_state(paths: &RuntimePaths) -> Option<ServiceState> {
    serde_json::from_slice(&std::fs::read(state_file(paths)).ok()?).ok()
}

fn save_state(paths: &RuntimePaths, state: &ServiceState) {
    if let Ok(bytes) = serde_json::to_vec_pretty(state) {
        let _ = atomic_replace(&state_file(paths), &bytes, 0o600);
    }
}

/// Whether the watch should be started again after exiting with `code`.
pub(crate) fn should_restart(code: Option<i32>) -> bool {
    !code.is_some_and(|code| code == 0 || TERMINAL_EXIT_CODES.contains(&code))
}

/// How long to wait before the next start, and the wait after that.
pub(crate) fn backoff_after(current: Duration, ran_for: Duration) -> (Duration, Duration) {
    let wait = if ran_for >= HEALTHY_RUN {
        FIRST_BACKOFF
    } else {
        current
    };
    (wait, (wait * 2).min(BACKOFF_CEILING))
}

pub(crate) fn run(name: &str, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let paths = absolute_paths(paths)?;
    create_private_dir(&log_dir(&paths))?;
    cap_file(&super::launchd::stdio_log(&log_dir(&paths)), LOG_CAP_BYTES);
    let log = Arc::new(Mutex::new(LogFile::new(log_file(&paths), LOG_CAP_BYTES)));
    let program = own_program();
    let note = |text: String| {
        if let Ok(mut log) = log.lock() {
            log.line(&format!("service: {text}"));
        }
    };
    let mut state = ServiceState {
        name: name.to_owned(),
        pid: std::process::id(),
        started_at: Some(Utc::now()),
        ..ServiceState::default()
    };
    note(format!(
        "{name} started, memoar {} at {}",
        env!("CARGO_PKG_VERSION"),
        program.display()
    ));
    let mut backoff = FIRST_BACKOFF;
    loop {
        let started = Instant::now();
        let started_at = Utc::now();
        let (code, last_words) = match spawn_watch(&program, &paths) {
            Ok(child) => {
                state.child_pid = Some(child.id());
                save_state(&paths, &state);
                supervise(child, &program, &log)
            }
            Err(error) => (
                None,
                format!("could not start {}: {error}", program.display()),
            ),
        };
        state.child_pid = None;
        if code == Some(UPGRADED) {
            note("the binary changed on disk, restarting the watch on the new one".to_owned());
            backoff = FIRST_BACKOFF;
            continue;
        }
        state.last_exit = Some(Exit {
            at: Utc::now(),
            code,
            message: last_words.clone(),
        });
        if !should_restart(code) {
            record_stop(&paths, code, &last_words, started_at);
            note(format!("background capture stopped: {last_words}"));
            save_state(&paths, &state);
            if let Ok(mut log) = log.lock() {
                log.flush_repeats();
            }
            return Ok(CommandOutput {
                command: "service run".to_owned(),
                data: json!({ "stopped": true, "exitCode": code, "reason": last_words }),
            });
        }
        state.restarts += 1;
        save_state(&paths, &state);
        let (wait, next) = backoff_after(backoff, started.elapsed());
        backoff = next;
        note(format!(
            "the watch exited ({}), restarting in {}s: {last_words}",
            code.map_or_else(|| "killed".to_owned(), |code| format!("exit {code}")),
            wait.as_secs()
        ));
        thread::sleep(wait);
    }
}

/// A sentinel exit for "restarted for an upgrade", outside the real range.
const UPGRADED: i32 = -1_000;

/// The path the service manager started this by. It is the stable one the
/// definition names, where `current_exe` may be a resolved, versioned path.
fn own_program() -> PathBuf {
    std::env::args_os()
        .next()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::current_exe().ok())
        .unwrap_or_else(|| PathBuf::from("memoar"))
}

fn spawn_watch(program: &Path, paths: &RuntimePaths) -> Result<Child, String> {
    let mut command = Command::new(program);
    command
        .args(["sync", "--watch"])
        .args(directory_arguments(paths).map_err(|error| error.message)?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.spawn().map_err(|error| error.to_string())
}

/// Waits for the child, copying its output to the log. Returns its exit code
/// and the last thing it said on stderr, which is its error when it failed.
fn supervise(mut child: Child, program: &Path, log: &Arc<Mutex<LogFile>>) -> (Option<i32>, String) {
    let last_words = Arc::new(Mutex::new(Vec::<String>::new()));
    let pumps = [
        child.stdout.take().map(|out| pump(out, log.clone(), None)),
        child
            .stderr
            .take()
            .map(|err| pump(err, log.clone(), Some(last_words.clone()))),
    ];
    let fingerprint = fingerprint(program);
    let mut checked = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(_) => break None,
        }
        if checked.elapsed() >= UPGRADE_CHECK {
            checked = Instant::now();
            let now = self::fingerprint(program);
            if now.is_some() && now != fingerprint {
                let _ = child.kill();
                let _ = child.wait();
                break Some(UPGRADED);
            }
        }
        thread::sleep(POLL);
    };
    for pump in pumps.into_iter().flatten() {
        let _ = pump.join();
    }
    let words = last_words
        .lock()
        .map(|lines| lines.join(" "))
        .unwrap_or_default();
    (code, words)
}

fn pump(
    stream: impl Read + Send + 'static,
    log: Arc<Mutex<LogFile>>,
    last_words: Option<Arc<Mutex<Vec<String>>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            if let Ok(mut log) = log.lock() {
                log.line(&line);
            }
            if let Some(words) = &last_words
                && let Ok(mut words) = words.lock()
            {
                words.push(line);
                let excess = words.len().saturating_sub(2);
                words.drain(..excess);
            }
        }
    })
}

fn fingerprint(program: &Path) -> Option<(u64, SystemTime)> {
    let metadata = std::fs::metadata(program).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

/// Writes why capture stopped into the capture state, unless the watch got
/// there first. It does for a refusal mid-watch, and cannot for a failure
/// before its loop starts, such as a configuration that was signed out.
fn record_stop(paths: &RuntimePaths, code: Option<i32>, words: &str, started: DateTime<Utc>) {
    let mut state = capture_state::load(paths).unwrap_or_default();
    if state
        .stopped
        .as_ref()
        .is_some_and(|stopped| stopped.at >= started)
    {
        return;
    }
    let (message, hint) = split_error(words);
    state.stopped = Some(Failure {
        at: Utc::now(),
        code: format!("MEMOAR_EXIT_{}", code.unwrap_or(-1)),
        exit_code: code.and_then(|code| u8::try_from(code).ok()).unwrap_or(0),
        message,
        hint,
    });
    capture_state::save(paths, &state);
}

/// `memoar: <message> hint: <hint>`, as `main` prints an error.
pub(crate) fn split_error(words: &str) -> (String, String) {
    let words = words.trim().trim_start_matches("memoar: ");
    match words.split_once(" hint: ") {
        Some((message, hint)) => (message.to_owned(), hint.to_owned()),
        None => (words.to_owned(), "Run `memoar doctor`.".to_owned()),
    }
}
