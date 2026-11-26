// Used only by the symlink-ancestor test below, which is unix-only.
#[cfg(unix)]
use std::fs;

use super::fixtures::{SESSION_ID, single_file_bundle};
use crate::entry::materialize_bundle;
use crate::error::MaterializeError;
use crate::paths::resolve_bundle_path;
use crate::target::Target;

#[test]
fn refuses_a_bundle_path_that_climbs_out_of_the_target_directory() {
    // The archive names the workspace directory. A name of ".." contains no
    // separator, so it must be caught when the path is resolved here.
    let temp = tempfile::tempdir().unwrap();
    for hostile in [
        format!("~/.claude/projects/../{SESSION_ID}.jsonl"),
        format!("~/.config/{SESSION_ID}.jsonl"),
        format!("/etc/{SESSION_ID}.jsonl"),
        "~/.claude/projects/p/other.jsonl".to_owned(),
        format!("~/.gemini/antigravity-cli/brain/{SESSION_ID}/{SESSION_ID}.db"),
    ] {
        let bundle = single_file_bundle(Target::ClaudeCode, &hostile, b"{}\n");
        assert!(
            matches!(
                materialize_bundle(&bundle, temp.path()),
                Err(MaterializeError::UnsafePath(_))
            ),
            "{hostile} must be refused"
        );
    }
    assert!(!temp.path().join(".claude").exists());
}

#[test]
fn refuses_path_traversal_session_ids_and_bundle_paths() {
    let temp = tempfile::tempdir().unwrap();
    let mut bundle = single_file_bundle(
        Target::Codex,
        &format!("~/.codex/sessions/2026/08/17/rollout-{SESSION_ID}.jsonl"),
        b"{}\n",
    );
    bundle.session_id = "../../outside".to_owned();
    let bundle = super::fixtures::finalized_bundle(bundle);
    assert!(matches!(
        materialize_bundle(&bundle, temp.path()),
        Err(MaterializeError::InvalidSessionId(_))
    ));
    assert!(
        resolve_bundle_path(
            temp.path(),
            "~/.codex/sessions/../../escape.jsonl",
            Target::Codex,
            "safe-id"
        )
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn refuses_symlink_ancestor() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), temp.path().join(".claude")).unwrap();
    let bundle = single_file_bundle(
        Target::ClaudeCode,
        &format!("~/.claude/projects/-tmp-project/{SESSION_ID}.jsonl"),
        b"{}\n",
    );
    assert!(matches!(
        materialize_bundle(&bundle, temp.path()),
        Err(MaterializeError::UnsafePath(_))
    ));
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}
