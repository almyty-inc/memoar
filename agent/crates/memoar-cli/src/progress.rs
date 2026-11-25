//! Upload progress on stderr: a live line in a terminal, a periodic line in a log.

use memoar_daemon::Progress;
use std::io::{IsTerminal, Write};
use std::time::{Duration, Instant};

use crate::capture_policy::human_bytes;

/// How progress is shown, decided once per command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProgressMode {
    /// `--json`, where stdout and stderr stay for the envelope and errors.
    Silent,
    /// A person watching: one line, redrawn.
    Live,
    /// A log file, such as the background service's: a line now and then.
    Periodic,
}

impl ProgressMode {
    pub(crate) fn for_command(json_mode: bool) -> Self {
        if json_mode {
            Self::Silent
        } else if std::io::stderr().is_terminal() {
            Self::Live
        } else {
            Self::Periodic
        }
    }
}

pub(crate) struct ProgressPrinter {
    mode: ProgressMode,
    last: Option<Instant>,
    drawn: bool,
}

impl ProgressPrinter {
    pub(crate) fn new(mode: ProgressMode) -> Self {
        Self {
            mode,
            last: None,
            drawn: false,
        }
    }

    pub(crate) fn update(&mut self, progress: &Progress) {
        let every = match self.mode {
            ProgressMode::Silent => return,
            ProgressMode::Live => Duration::from_millis(250),
            ProgressMode::Periodic => Duration::from_secs(30),
        };
        let finished = progress.done >= progress.total;
        if !finished && self.last.is_some_and(|last| last.elapsed() < every) {
            return;
        }
        self.last = Some(Instant::now());
        let line = describe(progress);
        let mut stderr = std::io::stderr().lock();
        let _ = if self.mode == ProgressMode::Live {
            self.drawn = true;
            write!(stderr, "\r\x1b[2K{line}")
        } else {
            writeln!(stderr, "memoar: {line}")
        };
        let _ = stderr.flush();
    }

    /// Ends a live line, so whatever prints next starts on its own.
    pub(crate) fn finish(&mut self) {
        if self.drawn {
            eprintln!();
            self.drawn = false;
        }
    }
}

pub(crate) fn describe(progress: &Progress) -> String {
    let percent = (progress.done * 100)
        .checked_div(progress.total)
        .unwrap_or(100)
        .min(100);
    let mut line = format!(
        "uploading {}/{} ({percent}%), {} sent, {:.1}/s",
        progress.done,
        progress.total,
        human_bytes(progress.bytes_uploaded),
        progress.rate()
    );
    if progress.failed > 0 {
        line.push_str(&format!(", {} to retry", progress.failed));
    }
    if let Some(eta) = progress.eta() {
        line.push_str(&format!(", about {} left", duration_words(eta)));
    }
    line
}

fn duration_words(duration: Duration) -> String {
    let seconds = duration.as_secs();
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3600 => format!("{}m", seconds / 60),
        _ => format!("{}h {}m", seconds / 3600, seconds / 60 % 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_progress_line_says_how_far_how_fast_and_how_long() {
        let progress = Progress {
            total: 1000,
            total_bytes: 0,
            done: 250,
            uploaded: 240,
            duplicates: 5,
            failed: 5,
            bytes_uploaded: 2_500_000,
            elapsed: Duration::from_secs(60),
        };
        assert_eq!(
            describe(&progress),
            "uploading 250/1000 (25%), 2.5 MB sent, 4.0/s, 5 to retry, about 3m left"
        );
    }
}
