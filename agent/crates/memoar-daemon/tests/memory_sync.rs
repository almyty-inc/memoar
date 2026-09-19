//! What leaves the machine when the instruction files are swept.

use memoar_daemon::memory::{MemoryCaptureRequest, MemoryOutcome, MemorySync, MemoryTransport};
use memoar_daemon::{DaemonError, RedactionConfig};
use std::cell::RefCell;
use std::fs;
use std::path::Path;

#[derive(Default)]
struct Recording {
    requests: RefCell<Vec<MemoryCaptureRequest>>,
    offline: bool,
}

impl MemoryTransport for Recording {
    fn capture_memory(&self, request: &MemoryCaptureRequest) -> Result<MemoryOutcome, DaemonError> {
        if self.offline {
            return Err(DaemonError::Transport("offline".to_owned()));
        }
        self.requests.borrow_mut().push(request.clone());
        Ok(MemoryOutcome::Recorded)
    }
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn everything() -> RedactionConfig {
    RedactionConfig {
        secrets: true,
        email_addresses: true,
        home_paths: true,
    }
}

/// Assembled at runtime so the repository's own secret scan does not flag it.
fn fixture_value() -> String {
    ["sk", "livefixtureabcdefghij"].join("-")
}

/// The instruction files get the redaction the transcripts get.
///
/// They did not get any. `MemorySync::run` read each file with
/// `read_to_string` and posted the text, and no `RedactionConfig` was ever
/// passed in — so somebody who ran `memoar login --redact-secrets
/// --redact-email-addresses --redact-home-paths` had their sessions scrubbed
/// and their `~/.claude/CLAUDE.md`, every project `AGENTS.md` and every
/// `~/.claude/projects/*/memory/*.md` uploaded byte for byte. Those are exactly
/// the files a connection string gets pasted into, and they had been told
/// redaction was on.
#[test]
fn redacts_an_instruction_file_before_it_leaves_the_machine() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let project = temp.path().join("repo");
    write(
        &home.join(".claude/CLAUDE.md"),
        format!(
            r#"deploy with api_key = "{}" and mail alice@example.com"#,
            fixture_value()
        )
        .as_bytes(),
    );
    write(
        &home.join(".claude/projects/-repo/memory/state.md"),
        b"the staging box lives at /Users/alice/work",
    );
    write(&project.join("AGENTS.md"), b"DB_PASSWORD=opensesame1234");

    let transport = Recording::default();
    let report = MemorySync::with_redaction(everything()).run(
        &transport,
        &home,
        std::slice::from_ref(&project),
        "machine",
        "2026-08-20T00:00:00Z",
    );
    assert_eq!((report.found, report.uploaded), (3, 3));

    let all = transport
        .requests
        .borrow()
        .iter()
        .map(|request| request.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    for leaked in [
        fixture_value().as_str(),
        "alice@example.com",
        "/Users/alice",
        "opensesame1234",
    ] {
        assert!(
            !all.contains(leaked),
            "{leaked} was uploaded verbatim: {all}"
        );
    }
    assert!(all.contains("[REDACTED]"), "nothing was put in its place");
}

/// A caller that asked for no redaction still gets the file unchanged.
#[test]
fn leaves_an_instruction_file_alone_when_no_redaction_was_asked_for() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let body = format!(r#"api_key = "{}""#, fixture_value());
    write(&home.join(".claude/CLAUDE.md"), body.as_bytes());

    let transport = Recording::default();
    MemorySync::new().run(&transport, &home, &[], "machine", "2026-08-20T00:00:00Z");
    assert_eq!(transport.requests.borrow()[0].text, body);
}

/// And a file redaction cannot be applied to stays here, and is counted.
///
/// The same fail-closed refusal an artifact gets: bytes that are not text
/// cannot have a pattern applied to them, so if a lossy look shows something
/// that should have been removed, the file does not go up.
#[test]
fn refuses_an_instruction_file_it_cannot_scan() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let mut bytes = format!(r#"api_key = "{}" "#, fixture_value()).into_bytes();
    bytes.extend_from_slice(&[0xff, 0xfe, 0x00]);
    write(&home.join(".claude/CLAUDE.md"), &bytes);

    let transport = Recording::default();
    let report = MemorySync::with_redaction(everything()).run(
        &transport,
        &home,
        &[],
        "machine",
        "2026-08-20T00:00:00Z",
    );
    assert_eq!(report.found, 1);
    assert_eq!(report.refused, 1, "the refusal has to be visible");
    assert_eq!(report.uploaded, 0);
    assert!(
        transport.requests.borrow().is_empty(),
        "nothing may be sent for a file that could not be scanned"
    );
}

/// An offline sweep uploaded nothing, and has to say so.
///
/// `report.uploaded += 1` ran before the request, so a machine with no network
/// reported `uploaded: 170, failed: 170` — a hundred and seventy files
/// described in the same breath as having gone up and as having not. Same class
/// as the `duplicates` count that was already fixed in the artifact sync.
#[test]
fn an_offline_sweep_does_not_claim_to_have_uploaded_anything() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    write(&home.join(".claude/CLAUDE.md"), b"be terse");
    write(&home.join(".codex/AGENTS.md"), b"codex global");

    let offline = Recording {
        offline: true,
        ..Recording::default()
    };
    let report = MemorySync::new().run(&offline, &home, &[], "machine", "2026-08-20T00:00:00Z");
    assert_eq!(report.found, 2);
    assert_eq!(report.failed, 2);
    assert_eq!(
        report.uploaded, 0,
        "nothing reached the archive, so nothing was uploaded"
    );
    assert_eq!(report.recorded, 0);
}
