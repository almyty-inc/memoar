//! The machine half of the session-conversion agreement.
//!
//! `server/test/conversion-bundle-parity.test.ts` holds the archive to the same
//! two files. Between them, neither half can change what it builds or what it
//! accepts without the other failing.

use std::fs;

use crate::bundle::ConversionBundle;
use crate::entry::materialize_bundle;
use crate::native::encode_claude_workspace;

/// The archive's own bundle, written to a disk by the code that writes disks.
///
/// The archive used to build this database with tables of its own invention —
/// `conversations` and `messages` — while `validate_antigravity_database` looks
/// for `trajectory_meta`. Every `antigravity-cli` conversion was therefore
/// refused on the user's machine with `Antigravity database lacks
/// trajectory_meta`, and neither side could see it: the archive asserted its own
/// tables and this crate built its own database to test against.
#[test]
fn materializes_the_committed_server_bundle() {
    let temp = tempfile::tempdir().unwrap();
    let bundle: ConversionBundle = serde_json::from_str(include_str!(
        "../../../../../contracts/fixtures/session-conversion-bundle.json"
    ))
    .expect("the committed bundle must parse as one");

    let result = materialize_bundle(&bundle, temp.path())
        .expect("the archive's own bundle must be one this crate will write");

    assert_eq!(result.written.len(), 3, "transcript, database, walkthrough");
    let brain = temp
        .path()
        .join(".gemini/antigravity-cli/brain")
        .join(&bundle.session_id);
    assert!(brain.join("walkthrough.md").exists());
    assert!(
        brain
            .join("conversations")
            .join(format!("{}.db", bundle.session_id))
            .exists()
    );
    let transcript =
        fs::read_to_string(brain.join(".system_generated/logs/transcript.jsonl")).unwrap();
    assert!(
        transcript.lines().count() > 1,
        "the transcript is the file of the three that carries the conversation"
    );
    assert!(transcript.contains("\"type\":\"message\""), "{transcript}");
}

/// The directory name both halves have to compute the same way.
///
/// The archive names `~/.claude/projects/<workspace>/` and this crate decides
/// whether it will write there. They are two copies of one encoder, and the cap
/// that keeps the name inside a path component was added to this one only —
/// which is how a 531-byte component reached a user's disk and died with
/// `File name too long (os error 63)`.
#[test]
fn encodes_a_workspace_the_way_the_archive_does() {
    #[derive(serde::Deserialize)]
    struct Case {
        workspace: String,
        encoded: String,
    }
    #[derive(serde::Deserialize)]
    struct Cases {
        cases: Vec<Case>,
    }

    let cases: Cases = serde_json::from_str(include_str!(
        "../../../../../contracts/fixtures/claude-workspace-names.json"
    ))
    .expect("the committed name table must parse");
    assert!(
        cases.cases.len() > 4,
        "the table must cover more than a path"
    );

    for case in &cases.cases {
        assert_eq!(
            encode_claude_workspace(&case.workspace),
            case.encoded,
            "the archive and this crate would file {:?} under two directories",
            case.workspace
        );
        assert!(
            case.encoded.len() <= 255,
            "a path component may not exceed 255 bytes: {}",
            case.encoded.len()
        );
    }
}
