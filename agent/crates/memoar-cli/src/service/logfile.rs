//! The service's log: one file in the data directory, capped and rotated.
//!
//! A watch polls every two seconds and prints a line each time, so a log that
//! kept everything would grow by megabytes a day on a machine doing nothing.
//! A line that repeats the one before it is counted rather than written, and
//! the file is rotated at a fixed size with two older copies kept.

use chrono::Utc;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Rotate at this size. Three files at most, so 15 MiB on disk at most.
pub(crate) const LOG_CAP_BYTES: u64 = 5 * 1024 * 1024;
const KEEP: u32 = 2;

pub(crate) struct LogFile {
    path: PathBuf,
    cap: u64,
    last: Option<String>,
    repeats: u64,
}

impl LogFile {
    pub(crate) fn new(path: PathBuf, cap: u64) -> Self {
        Self {
            path,
            cap,
            last: None,
            repeats: 0,
        }
    }

    /// Appends one line with a timestamp, or counts it when it repeats.
    pub(crate) fn line(&mut self, text: &str) {
        let text = text.trim_end();
        if self.last.as_deref() == Some(text) {
            self.repeats += 1;
            return;
        }
        self.flush_repeats();
        self.write(text);
        self.last = Some(text.to_owned());
    }

    /// Writes the count of lines held back, so a reader knows they happened.
    pub(crate) fn flush_repeats(&mut self) {
        if self.repeats > 0 {
            let note = format!("(the line above repeated {} more times)", self.repeats);
            self.repeats = 0;
            self.write(&note);
        }
    }

    fn write(&mut self, text: &str) {
        self.rotate_if_full();
        let stamped = format!("{} {text}\n", Utc::now().format("%Y-%m-%dT%H:%M:%SZ"));
        // Best effort: a log that cannot be written must not stop capture.
        // Owner-only, like the rest of the data directory: it names paths
        // and the archive's errors.
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Ok(mut file) = options.open(&self.path) {
            let _ = file.write_all(stamped.as_bytes());
        }
    }

    fn rotate_if_full(&self) {
        let full = fs::metadata(&self.path).is_ok_and(|metadata| metadata.len() >= self.cap);
        if full {
            rotate(&self.path);
        }
    }
}

/// `agent.log` becomes `agent.log.1`, `.1` becomes `.2`, and the oldest goes.
pub(crate) fn rotate(path: &Path) {
    for index in (1..KEEP).rev() {
        let _ = fs::rename(numbered(path, index), numbered(path, index + 1));
    }
    let _ = fs::rename(path, numbered(path, 1));
}

fn numbered(path: &Path, index: u32) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

/// Empties a file the service manager writes to and nothing rotates, once it
/// is past the cap. Only the service's own crashes reach it.
pub(crate) fn cap_file(path: &Path, cap: u64) {
    if fs::metadata(path).is_ok_and(|metadata| metadata.len() >= cap) {
        let _ = OpenOptions::new().write(true).truncate(true).open(path);
    }
}

/// The last `count` lines of the log, reading the rotated copy too when the
/// current file holds fewer.
pub(crate) fn tail(path: &Path, count: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for file in [numbered(path, 1), path.to_path_buf()] {
        if let Ok(text) = fs::read_to_string(&file) {
            lines.extend(text.lines().map(str::to_owned));
        }
    }
    let skip = lines.len().saturating_sub(count);
    lines.split_off(skip)
}
