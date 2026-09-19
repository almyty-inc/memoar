use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::json;
use std::fs;

use super::fixtures::{finalized_bundle, fixture_session};
use crate::bundle::{BundleFile, ConversionBundle, PlannedFile};
use crate::commit::commit_plan_with_hook;
use crate::entry::materialize_bundle;
use crate::error::MaterializeError;
use crate::paths::resolve_bundle_path;
use crate::target::Target;

#[test]
fn refuses_collision_before_writing_any_bundle_file() {
    let temp = tempfile::tempdir().unwrap();
    let session_id = fixture_session().id;
    let first = temp
        .path()
        .join(format!(".claude/projects/-tmp/{session_id}.jsonl"));
    fs::create_dir_all(first.parent().unwrap()).unwrap();
    fs::write(&first, "existing").unwrap();
    let second = format!("~/.claude/projects/-tmp/{session_id}-other.jsonl");
    let bundle = finalized_bundle(ConversionBundle {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        bundle_version: "1".to_owned(),
        bundle_sha256: String::new(),
        target: Target::ClaudeCode,
        session_id: session_id.clone(),
        files: vec![
            BundleFile {
                path: format!("~/.claude/projects/-tmp/{session_id}.jsonl"),
                media_type: "application/x-ndjson".to_owned(),
                base64: BASE64.encode("different"),
                sha256: String::new(),
                size: 0,
            },
            BundleFile {
                path: second.clone(),
                media_type: "application/x-ndjson".to_owned(),
                base64: BASE64.encode("new"),
                sha256: String::new(),
                size: 0,
            },
        ],
        resume_command: String::new(),
        report: json!({}),
    });
    assert!(matches!(
        materialize_bundle(&bundle, temp.path()),
        Err(MaterializeError::Collision(_))
    ));
    assert!(
        !resolve_bundle_path(temp.path(), &second, Target::ClaudeCode, &session_id)
            .unwrap()
            .exists()
    );
}

#[test]
fn multi_file_commit_rolls_back_each_injected_failure_point() {
    for fail_at in 0..3 {
        let temp = tempfile::tempdir().unwrap();
        let planned: Vec<_> = (0..3)
            .map(|index| PlannedFile {
                path: temp.path().join(format!("native/session-{index}.jsonl")),
                bytes: format!("record-{index}").into_bytes(),
            })
            .collect();
        let result = commit_plan_with_hook(temp.path(), &planned, |index| {
            if index == fail_at {
                Err(std::io::Error::other("injected commit failure"))
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert!(planned.iter().all(|file| !file.path.exists()));
    }
}
