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
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Recording {
        requests: RefCell<Vec<MemoryCaptureRequest>>,
        fail: bool,
    }

    impl MemoryTransport for Recording {
        fn capture_memory(
            &self,
            request: &MemoryCaptureRequest,
        ) -> Result<MemoryOutcome, DaemonError> {
            if self.fail {
                return Err(DaemonError::Transport("offline".into()));
            }
            self.requests.borrow_mut().push(request.clone());
            Ok(MemoryOutcome::Recorded)
        }
    }

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn uploads_a_file_once_and_again_only_when_it_changes() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("repo");
        write(&home.join(".claude/CLAUDE.md"), "be terse");
        write(&project.join("AGENTS.md"), "project rules");

        let transport = Recording::default();
        let mut sync = MemorySync::new();
        let workspaces = vec![project.clone()];

        let first = sync.run(
            &transport,
            &home,
            &workspaces,
            "machine",
            "2026-08-20T00:00:00Z",
        );
        assert_eq!((first.found, first.uploaded, first.recorded), (2, 2, 2));

        // Nothing changed: the second sweep sends nothing at all.
        let second = sync.run(
            &transport,
            &home,
            &workspaces,
            "machine",
            "2026-08-20T01:00:00Z",
        );
        assert_eq!((second.found, second.uploaded), (2, 0));

        write(&project.join("AGENTS.md"), "project rules, revised");
        let third = sync.run(
            &transport,
            &home,
            &workspaces,
            "machine",
            "2026-08-20T02:00:00Z",
        );
        assert_eq!(third.uploaded, 1);

        let requests = transport.requests.borrow();
        assert_eq!(requests.len(), 3);
        let latest = requests.last().unwrap();
        assert_eq!(latest.text, "project rules, revised");
        assert_eq!(latest.scope, "project");
        assert_eq!(
            latest.workspace_path.as_deref(),
            Some(project.to_string_lossy().as_ref())
        );
        assert!(latest.readers.contains(&"codex".to_owned()));
    }

    #[test]
    fn retries_a_file_whose_upload_failed() {
        // A file dropped into the cache after a failure would never be sent
        // again, and the archive would be missing it until it happened to be
        // edited.
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        write(&home.join(".claude/CLAUDE.md"), "be terse");

        let mut sync = MemorySync::new();
        let offline = Recording {
            fail: true,
            ..Recording::default()
        };
        let failed = sync.run(&offline, &home, &[], "machine", "2026-08-20T00:00:00Z");
        // Nothing arrived, so nothing is reported as having arrived.
        assert_eq!((failed.uploaded, failed.failed, failed.recorded), (0, 1, 0));

        let online = Recording::default();
        let recovered = sync.run(&online, &home, &[], "machine", "2026-08-20T01:00:00Z");
        assert_eq!((recovered.uploaded, recovered.recorded), (1, 1));
    }

    #[test]
    fn sends_the_title_nowhere_and_the_path_everywhere() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        write(&home.join(".codex/AGENTS.md"), "codex global");

        let transport = Recording::default();
        MemorySync::new().run(&transport, &home, &[], "machine", "2026-08-20T00:00:00Z");

        let requests = transport.requests.borrow();
        let body = serde_json::to_value(&requests[0]).unwrap();
        assert!(
            body.get("title").is_none(),
            "the server derives it from the path"
        );
        assert!(
            body.get("contentHash").is_none(),
            "and hashes the text itself"
        );
        assert_eq!(body["scope"], "global");
        assert!(
            body.get("workspacePath").is_none(),
            "a global file has no project"
        );
    }
}
