//! Uploading the instruction files the agents on this machine read.
//!
//! These are not transcripts and do not go through the artifact queue: there is
//! nothing to parse, and what matters is whether the text changed since the
//! last reading. They are small, they are read on a timer, and almost every
//! reading finds them exactly as they were.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use memoar_connectors::memory::{DiscoveredMemory, memory_files};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{DaemonError, HttpTransport, RedactionConfig, redact_artifact};

/// One reading of one memory file, as the API expects it.
///
/// The title is absent on purpose: it is the name of the file, which the path
/// already says, and the server derives it rather than letting the two differ.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCaptureRequest {
    pub scope: String,
    pub machine_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    pub path: String,
    pub readers: Vec<String>,
    pub text: String,
    pub captured_at: String,
}

/// Whether the reading recorded a new revision, or found the file unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryOutcome {
    Recorded,
    Unchanged,
}

pub trait MemoryTransport {
    fn capture_memory(&self, request: &MemoryCaptureRequest) -> Result<MemoryOutcome, DaemonError>;
}

impl MemoryTransport for HttpTransport {
    fn capture_memory(&self, request: &MemoryCaptureRequest) -> Result<MemoryOutcome, DaemonError> {
        #[derive(Deserialize)]
        struct Response {
            revision: Option<serde_json::Value>,
        }
        let response = self
            .post_json("/memory", request)?
            .json::<Response>()
            .map_err(|error| DaemonError::Protocol(error.to_string()))?;
        Ok(if response.revision.is_some() {
            MemoryOutcome::Recorded
        } else {
            MemoryOutcome::Unchanged
        })
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    pub found: usize,
    /// Files the server accepted. This counted attempts, so a sweep with no
    /// network reported `uploaded: 170, failed: 170` — a hundred and seventy
    /// files described as having gone up and, in the same breath, as having
    /// not.
    pub uploaded: usize,
    pub recorded: usize,
    pub failed: usize,
    /// Files redaction could not be applied to, which therefore stayed here.
    pub refused: usize,
}

/// Uploads memory files, skipping the ones that have not changed.
///
/// The server would discard an unchanged reading anyway, but sending it still
/// costs a request and the whole file: on this machine the sweep finds a
/// hundred and seventy of these, and almost none of them differ from one sweep
/// to the next.
#[derive(Debug, Default)]
pub struct MemorySync {
    uploaded: HashMap<PathBuf, String>,
    redaction: RedactionConfig,
}

impl MemorySync {
    /// A sweep that redacts nothing, for a caller that has no redaction
    /// configured. Anyone holding a `RedactionConfig` wants `with_redaction`:
    /// these files are where people write the keys.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The redaction the user switched on, applied to instruction files too.
    ///
    /// It was applied to transcripts and to nothing else. Somebody who ran
    /// `memoar login --redact-secrets --redact-email-addresses
    /// --redact-home-paths` had their sessions scrubbed and their
    /// `~/.claude/CLAUDE.md`, every project `AGENTS.md` and every
    /// `~/.claude/projects/*/memory/*.md` uploaded byte for byte — which are
    /// exactly the files a connection string gets pasted into, and they had
    /// been told redaction was on.
    #[must_use]
    pub fn with_redaction(redaction: RedactionConfig) -> Self {
        Self {
            uploaded: HashMap::new(),
            redaction,
        }
    }

    pub fn run<T: MemoryTransport>(
        &mut self,
        transport: &T,
        home: &Path,
        workspaces: &[PathBuf],
        machine_id: &str,
        captured_at: &str,
    ) -> MemoryReport {
        let discovered = memory_files(home, workspaces);
        let mut report = MemoryReport {
            found: discovered.len(),
            ..MemoryReport::default()
        };
        for file in discovered {
            let Ok(bytes) = fs::read(&file.path) else {
                // Not readable: something else that happens to share the name.
                // Not an error, and not ours to report as one.
                continue;
            };
            // Hash what is on disk, not what gets sent, so "has this file
            // changed" keeps meaning that whatever the redaction settings are.
            //
            // sha2 0.11 no longer implements LowerHex on its output array.
            let digest: String = Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            if self.uploaded.get(&file.path) == Some(&digest) {
                continue;
            }
            // The same redaction, and the same fail-closed refusal, that an
            // artifact gets. A file that cannot be scanned is not sent.
            let redacted = match redact_artifact(&file.path, &bytes, self.redaction) {
                Ok(redacted) => redacted,
                Err(_) => {
                    report.refused += 1;
                    continue;
                }
            };
            let Ok(text) = String::from_utf8(redacted.bytes) else {
                // Not text after all, and nothing in it tripped a pattern.
                // There is no instruction file here to archive.
                continue;
            };
            match transport.capture_memory(&request_for(&file, text, machine_id, captured_at)) {
                Ok(outcome) => {
                    // Counted here, after the server took it. Counting the
                    // attempt instead is how an offline sweep claimed to have
                    // uploaded everything it had just failed to upload.
                    report.uploaded += 1;
                    self.uploaded.insert(file.path, digest);
                    if outcome == MemoryOutcome::Recorded {
                        report.recorded += 1;
                    }
                }
                // Left out of the cache, so the next sweep tries it again.
                Err(_) => report.failed += 1,
            }
        }
        report
    }
}

fn request_for(
    file: &DiscoveredMemory,
    text: String,
    machine_id: &str,
    captured_at: &str,
) -> MemoryCaptureRequest {
    MemoryCaptureRequest {
        scope: file.scope.as_str().to_owned(),
        machine_id: machine_id.to_owned(),
        workspace_path: file
            .workspace
            .as_ref()
            .map(|workspace| workspace.to_string_lossy().into_owned()),
        path: file.path.to_string_lossy().into_owned(),
        readers: file
            .readers
            .iter()
            .map(|reader| (*reader).to_owned())
            .collect(),
        text,
        captured_at: captured_at.to_owned(),
    }
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
