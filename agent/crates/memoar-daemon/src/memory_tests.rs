//! Tests for the instruction files this crate handles.
//!
//! Split out because `memory.rs` was over the file-size rule and its own
//! test module was most of the excess. Nothing moved but the tests.

use super::*;
use std::cell::RefCell;

#[derive(Default)]
struct Recording {
    requests: RefCell<Vec<MemoryCaptureRequest>>,
    fail: bool,
}

impl MemoryTransport for Recording {
    fn capture_memory(&self, request: &MemoryCaptureRequest) -> Result<MemoryOutcome, DaemonError> {
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
