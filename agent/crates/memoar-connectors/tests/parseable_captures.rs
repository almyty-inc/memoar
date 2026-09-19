//! Capture patterns that named a file no parser could ever read.
//!
//! Three times now a source has pointed at the wrong file and the test agreed,
//! because the test named the wrong file too. `zed` collected the editor's
//! terminal history instead of its threads; `opencode` collected its own
//! configuration instead of its database. The cases below are the same defect
//! found in two more sources, each confirmed against the real directory on a
//! machine that runs the tool, and each asserted from both ends: the record
//! that must still be captured, and the file that must not be.

use memoar_connectors::{OperatingSystem, files_for_source, source};
use std::fs;
use std::path::{Path, PathBuf};

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

/// Paths below the fixture home, written with forward slashes whatever the
/// platform separator is.
///
/// Windows renders these with backslashes, so every expectation in this file
/// read as a mismatch there — the discovery was right and the comparison was
/// not.
fn relative(home: &Path, files: &[PathBuf]) -> Vec<String> {
    files
        .iter()
        .map(|path| {
            path.strip_prefix(home)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect()
}

/// The Claude desktop app's session files are settings, not conversations.
///
/// `claude-code-sessions/*/*/local_*.json` and the local-agent-mode twin held
/// `model`, `permissionMode`, `egressAllowedDomains`, the rendered system
/// prompt, `accountName` and `emailAddress` — and no message of any kind. On
/// the machine this was found on, 22 files matched and not one contained a
/// `parentUuid`, a `message` or a transcript, so every sync uploaded an email
/// address for an artifact the parser could only mark `unknown_format`.
///
/// The conversation is the CLI transcript those files name in `cliSessionId`,
/// which the `.claude/projects` pattern already captures.
#[test]
fn claude_code_captures_the_transcript_and_not_the_desktop_apps_settings() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();

    write(
        &home.join(".claude/projects/-repo/965f449c.jsonl"),
        "{\"uuid\":\"1\",\"message\":{\"role\":\"user\"}}\n",
    );
    // Byte for byte the shape of the real files: settings and an address.
    for directory in ["claude-code-sessions", "local-agent-mode-sessions"] {
        write(
            &home
                .join("Library/Application Support/Claude")
                .join(directory)
                .join("f64982ac/81cd8499/local_23cecaa6.json"),
            "{\"sessionId\":\"local_23cecaa6\",\"cliSessionId\":\"965f449c\",\
             \"model\":\"opus\",\"emailAddress\":\"someone@example.com\"}",
        );
    }

    let found = files_for_source(source("claude-code").unwrap(), home, OperatingSystem::Macos)
        .expect("discovery should not fail");
    let names = relative(home, &found);

    assert!(
        names.iter().any(|name| name.ends_with("965f449c.jsonl")),
        "the transcript must still be captured: {names:?}",
    );
    assert!(
        !names.iter().any(|name| name.contains("local_")),
        "the desktop app's settings are not a transcript, and carry an email \
         address the parser can only refuse: {names:?}",
    );
}

/// Antigravity's parser reads JSON lines and nothing else.
///
/// It has no SQLite branch — only a diagnostic string claiming one — so a
/// `conversations/*.db` pattern could never produce a session. It also named a
/// directory that does not exist: on the machine that runs this tool the
/// conversation databases live one level above `brain/`, and `brain/<id>/`
/// holds only `.system_generated` and `.user_uploaded`.
#[test]
fn antigravity_captures_the_transcript_log_and_not_bytes_it_cannot_read() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let brain = home.join(".gemini/antigravity-cli/brain/177db637");

    write(
        &brain.join(".system_generated/logs/transcript.jsonl"),
        "{\"type\":\"USER_INPUT\",\"content\":\"hello\"}\n",
    );
    // Where the databases really are, and what the old pattern reached for.
    write(
        &home.join(".gemini/antigravity-cli/conversations/177db637.db"),
        "SQLite format 3\0",
    );
    write(
        &brain.join("conversations/177db637.db"),
        "SQLite format 3\0",
    );
    write(&brain.join("plan.md"), "# not a transcript");

    let found = files_for_source(
        source("antigravity-cli").unwrap(),
        home,
        OperatingSystem::Macos,
    )
    .expect("discovery should not fail");
    let names = relative(home, &found);

    assert_eq!(
        names,
        vec![".gemini/antigravity-cli/brain/177db637/.system_generated/logs/transcript.jsonl"],
        "only the JSONL transcript is readable by the antigravity parser",
    );
}
