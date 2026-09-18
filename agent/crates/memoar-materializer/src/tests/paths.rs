// Used only by the symlink-ancestor test below, which is unix-only.
#[cfg(unix)]
use std::fs;

use super::fixtures::fixture_session;
use crate::entry::materialize;
use crate::error::MaterializeError;
use crate::paths::resolve_bundle_path;
use crate::target::Target;

#[test]
fn keeps_a_materialized_session_inside_the_projects_directory() {
    // workspace.path arrives from the server and is only encoded, never
    // validated. The encoder folds separators to '-' so the result is a
    // single component, but it preserves '.', so the components that
    // actually traverse have to be refused rather than encoded away.
    let temp = tempfile::tempdir().unwrap();
    let projects = temp.path().join(".claude/projects");
    let mut wrote_something = false;

    for hostile in [".", "../..", "..\\..", "....", "~", "/etc", "..;/"] {
        let mut session = fixture_session();
        session.workspace.path = hostile.to_owned();
        let Ok(result) = materialize(&session, Target::ClaudeCode, temp.path()) else {
            continue;
        };
        for written in &result.written {
            wrote_something = true;
            let resolved = written.canonicalize().expect("a written file must resolve");
            let root = projects
                .canonicalize()
                .expect("projects directory must exist once written");
            assert!(
                resolved.starts_with(&root),
                "workspace {hostile:?} escaped the projects directory: {}",
                resolved.display()
            );
        }
    }

    // Without this the loop could pass by refusing every input, which would
    // prove the guard is strict rather than that it is correct.
    assert!(
        wrote_something,
        "no workspace was accepted, so nothing was actually checked"
    );
}

#[test]
fn refuses_a_workspace_that_would_climb_out_of_the_projects_directory() {
    // ".." survives the encoder intact — it contains no separator and only
    // characters the encoder keeps — so it must be caught when the path is
    // written rather than when it is encoded.
    let temp = tempfile::tempdir().unwrap();
    let mut session = fixture_session();
    session.workspace.path = "..".to_owned();
    let error = materialize(&session, Target::ClaudeCode, temp.path())
        .expect_err("a workspace of '..' must not be materialized");
    assert!(
        matches!(error, MaterializeError::UnsafePath(_)),
        "expected an unsafe-path refusal, got: {error}"
    );
    assert!(
        !temp
            .path()
            .join(".claude")
            .join(format!("{}.jsonl", session.id))
            .exists(),
        "the refusal must happen before anything is written"
    );
}

#[test]
fn refuses_path_traversal_session_ids_and_bundle_paths() {
    let mut session = fixture_session();
    session.id = "../../outside".to_owned();
    let temp = tempfile::tempdir().unwrap();
    assert!(matches!(
        materialize(&session, Target::Codex, temp.path()),
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
    assert!(matches!(
        materialize(&fixture_session(), Target::ClaudeCode, temp.path()),
        Err(MaterializeError::UnsafePath(_))
    ));
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}
