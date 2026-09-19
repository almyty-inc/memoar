use memoar_connectors::OperatingSystem;
use memoar_daemon::{CaptureSummary, PollingCapture};
use serde_json::json;
use std::thread;
use std::time::{Duration, SystemTime};

use crate::CommandOutput;
use crate::args::SyncArgs;
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
    loop {
        match sync_pending(sweep, captured) {
            Ok(report) => {
                println!(
                    "captured {} artifacts, uploaded {}",
                    report["captured"], report["sync"]["uploaded"]
                );
                last = report;
                backoff = interval;
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
                retry_or_give_up(&error, &mut backoff)?;
            }
        }
        captured = match watcher.scan(
            sweep.queue,
            &sweep.paths.home,
            OperatingSystem::current(),
            &sweep.enabled,
            sweep.config.redaction,
            SystemTime::now(),
        ) {
            Ok(captured) => CaptureSummary {
                captured,
                skipped: Vec::new(),
            },
            Err(error) => {
                retry_or_give_up(&map_capture_error(error), &mut backoff)?;
                CaptureSummary {
                    captured: 0,
                    skipped: Vec::new(),
                }
            }
        };
    }
}

/// Waits out a failure a watch expects to outlive, or hands back the one it
/// does not. Sleeping here — rather than at the top of the loop — is what keeps
/// an unreachable archive from being asked again immediately, forever.
fn retry_or_give_up(error: &AppError, backoff: &mut Duration) -> Result<(), AppError> {
    if fatal_for_watch(error) {
        return Err(error.clone());
    }
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
/// Retryable is the error's own word for it — a network error or a queue
/// another process is holding will plausibly work on the next pass — with one
/// exception that word gets wrong. A 401 or 403 is delivered as a network
/// error, but the credential `login` stores does not expire: the archive is
/// saying revoked or not permitted, and asking again every five minutes until
/// somebody notices is worse than stopping and saying so.
pub(crate) fn fatal_for_watch(error: &AppError) -> bool {
    !error.retryable || refused_credentials(&error.message)
}

fn refused_credentials(message: &str) -> bool {
    message.ends_with("(HTTP 401)") || message.ends_with("(HTTP 403)")
}
