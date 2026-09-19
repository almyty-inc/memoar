//! What each source collects, and what it deliberately leaves behind.
//!
//! Split from `tests.rs`, which was over the 300-line rule. These three are
//! about the contents of the pattern lists rather than about discovery
//! mechanics, and each one exists because a real machine's files disagreed
//! with what the patterns said they would collect.

use super::*;
use std::fs;

/// `~/.claude/history.jsonl` is the prompt history, not a conversation.
///
/// It is the list the CLI's up-arrow reads: one record per thing typed, all of
/// them `{display, pastedContents, timestamp, project, sessionId}`. The parser
/// builds a turn out of `uuid` and `message`, and this file has neither on any
/// line — 10,619 of them on the machine this was measured on. Being named
/// `.jsonl` it passed the capture/parser agreement check, which compares
/// extensions, so nothing caught it: 2.8 MB re-uploaded on every sync, growing
/// with every prompt typed, carrying every prompt and every paste, and coming
/// back `unknown_format` every time.
#[test]
fn the_prompt_history_file_is_not_captured() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join(".claude/projects/-tmp-project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("session.jsonl"), "{}\n").unwrap();
    fs::write(
        temp.path().join(".claude/history.jsonl"),
        "{\"display\":\"hello\",\"pastedContents\":{},\"timestamp\":1,\"project\":\"/p\"}\n",
    )
    .unwrap();

    let files = files_for_source(
        source("claude-code").unwrap(),
        temp.path(),
        OperatingSystem::Linux,
    )
    .unwrap();

    assert!(
        files.iter().any(|path| path.ends_with("session.jsonl")),
        "the transcript must still be found, got {files:?}"
    );
    assert!(
        !files.iter().any(|path| path.ends_with("history.jsonl")),
        "the prompt history carries no uuid and no message and can only ever \
         come back unknown_format, got {files:?}"
    );
}

/// A session and the subagents it ran are one conversation.
///
/// Subagent transcripts are written a directory below the session that spawned
/// them, and some a further two below that, under `subagents/workflows/<id>/`.
/// `projects/*/*.jsonl` reaches none of them: 233 files on this machine,
/// carrying 58,467 lines with both `uuid` and `message`, against 15 top-level
/// transcripts. What sits beside them there is not transcript — the `.meta.json`
/// descriptor and the `tool-results/` attachments — and stays out.
#[test]
fn subagent_transcripts_are_captured_and_their_leftovers_are_not() {
    let temp = tempfile::tempdir().unwrap();
    let session = temp.path().join(".claude/projects/-tmp-project/s-1");
    fs::create_dir_all(session.join("subagents/workflows/wf_1")).unwrap();
    fs::create_dir_all(session.join("tool-results")).unwrap();

    fs::write(session.join("subagents/agent-one.jsonl"), "{}\n").unwrap();
    fs::write(
        session.join("subagents/workflows/wf_1/agent-two.jsonl"),
        "{}\n",
    )
    .unwrap();
    fs::write(session.join("subagents/agent-one.meta.json"), "{}\n").unwrap();
    fs::write(session.join("tool-results/page-1.jpg"), b"\xff\xd8\xff\xe0").unwrap();

    let files = files_for_source(
        source("claude-code").unwrap(),
        temp.path(),
        OperatingSystem::Linux,
    )
    .unwrap();

    for wanted in ["agent-one.jsonl", "agent-two.jsonl"] {
        assert!(
            files.iter().any(|path| path.ends_with(wanted)),
            "{wanted} is a transcript of this session, got {files:?}"
        );
    }
    for unwanted in ["agent-one.meta.json", "page-1.jpg"] {
        assert!(
            !files.iter().any(|path| path.ends_with(unwanted)),
            "{unwanted} is not a transcript, got {files:?}"
        );
    }
}

/// Copilot's CLI keeps its sessions in SQLite and nothing else.
///
/// The four `*.json` patterns that used to stand here named directories the CLI
/// writes no JSON into. On GitHub Copilot CLI 1.0.59 with a recorded session,
/// `session-state/<id>/` holds `workspace.yaml` and `checkpoints/index.md`, and
/// `history-session-state/` does not exist. The parser refuses anything that is
/// not native SQLite, so whatever those patterns had matched could only ever be
/// refused.
#[test]
fn copilot_takes_the_session_store_and_not_the_session_state() {
    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join(".copilot/session-state/s-1");
    fs::create_dir_all(state.join("checkpoints")).unwrap();
    fs::write(
        temp.path().join(".copilot/session-store.db"),
        b"SQLite format 3\0",
    )
    .unwrap();
    fs::write(state.join("workspace.yaml"), "cwd: /p\n").unwrap();
    fs::write(state.join("checkpoints/index.md"), "# checkpoints\n").unwrap();
    // The shapes the dropped patterns named, if the CLI ever writes them.
    fs::write(state.join("session.json"), "{}\n").unwrap();
    fs::write(temp.path().join(".copilot/config.json"), "{}\n").unwrap();

    let files = files_for_source(
        source("copilot").unwrap(),
        temp.path(),
        OperatingSystem::Linux,
    )
    .unwrap();

    assert!(
        files.iter().any(|path| path.ends_with("session-store.db")),
        "the session store is the only thing the parser can open, got {files:?}"
    );
    for unwanted in ["session.json", "config.json", "workspace.yaml", "index.md"] {
        assert!(
            !files.iter().any(|path| path.ends_with(unwanted)),
            "{unwanted} is not a native SQLite session store, got {files:?}"
        );
    }
}
