use memoar_connectors::OperatingSystem;
use memoar_daemon::{CaptureSummary, PollingCapture, ScanSources};
use serde_json::json;
use std::thread;
use std::time::{Duration, SystemTime};

use crate::CommandOutput;
use crate::args::SyncArgs;
use crate::capture_state::StateRecorder;
use crate::error::{AppError, map_capture_error};
use crate::sync::{Sweep, sync_pending};

/// How long a watch waits after a failure it expects to outlive.
///
/// The first retry is one poll interval — the watcher is already prepared to
/// wait that long — and doubles from there so an archive that is down for an
/// afternoon is asked about every five minutes rather than every two seconds.
const WATCH_BACKOFF_CEILING: Duration = Duration::from_secs(300);

/// Losing the network must not end a watch.
///
/// `sync --watch` exists to ride out being offline: the queue holds what was
/// captured until the archive is reachable again. Propagating the first
/// transport error out of the loop ended the process instead, so closing a lid
/// or changing wifi killed the watcher, and everything captured afterwards sat
/// on the laptop with nothing running to send it. The whole point of the
/// offline queue was a thing the watcher itself could not survive.
///
/// What still ends a watch is a condition repeating cannot fix: a credential
/// the archive refuses, a queue that will not open, a redaction setting no
/// capture can satisfy. See `fatal_for_watch`.
pub(crate) fn watch(
    args: &SyncArgs,
    sweep: &mut Sweep,
    first: CaptureSummary,
) -> Result<CommandOutput, AppError> {
    let interval = Duration::from_secs(args.interval_seconds.max(1));
    let mut watcher = PollingCapture::new(Duration::from_secs(args.debounce_seconds.max(1)));
    let mut backoff = interval;
    let mut captured = first;
    let mut completed = 0_usize;
    let mut last = json!({});
    let mut recorder = StateRecorder::start(sweep.paths);
    loop {
        match sync_pending(sweep, captured) {
            Ok(report) => {
                println!(
                    "captured {} artifacts, uploaded {}",
                    report["captured"], report["sync"]["uploaded"]
                );
                last = report;
                backoff = interval;
                recorder.succeeded();
                completed += 1;
                if args.max_cycles > 0 && completed >= args.max_cycles {
                    return Ok(CommandOutput {
                        command: "sync".to_owned(),
                        data: last,
                    });
                }
                thread::sleep(interval);
            }
            Err(error) => {
                retry_or_give_up(&error, &mut backoff, &mut recorder)?;
            }
        }
        let sources = ScanSources {
            home: &sweep.paths.home,
            os: OperatingSystem::current(),
            enabled: &sweep.enabled,
        };
        // A full disk is retryable: the watch waits for space rather than
        // ending, and `status` shows why nothing new is arriving.
        captured = match watcher.scan_with_policy(
            sweep.queue,
            &sources,
            sweep.config.redaction,
            &sweep.policy,
            SystemTime::now(),
        ) {
            Ok(captured) => captured,
            Err(error) => {
                retry_or_give_up(&map_capture_error(error), &mut backoff, &mut recorder)?;
                CaptureSummary::default()
            }
        };
    }
}

/// Waits out a failure a watch expects to outlive, or hands back the one it
/// does not. Sleeping here — rather than at the top of the loop — is what keeps
/// an unreachable archive from being asked again immediately, forever.
///
/// Either way the outcome is written down for `status`, because the terminal
/// this prints to may be gone by the time anybody asks.
fn retry_or_give_up(
    error: &AppError,
    backoff: &mut Duration,
    recorder: &mut StateRecorder,
) -> Result<(), AppError> {
    if fatal_for_watch(error) {
        recorder.stopped(error);
        return Err(error.clone());
    }
    recorder.failed(error);
    eprintln!(
        "memoar: {} — retrying in {}s",
        error.message,
        backoff.as_secs()
    );
    thread::sleep(*backoff);
    *backoff = (*backoff * 2).min(WATCH_BACKOFF_CEILING);
    Ok(())
}

/// Which failures a watch cannot outlive.
///
/// Retryable is the error's own word for it, and it is decided by status where
/// the archive answered: a revoked key (401), a deregistered machine, or any
/// other refusal is not retryable, and asking again every five minutes until
/// somebody notices is worse than stopping and saying so. A revoked machine
/// token is the exception the sync marks retryable itself, because the next
/// cycle mints a new one.
pub(crate) fn fatal_for_watch(error: &AppError) -> bool {
    !error.retryable
}
