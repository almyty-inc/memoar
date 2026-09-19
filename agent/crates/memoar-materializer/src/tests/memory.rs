use std::fs;

use crate::bundle::content_sha256;
use crate::error::MaterializeError;
use crate::memory::{
    MemoryBundleFile, MemoryConversionBundle, MemoryConversionReport, materialize_memory_bundle,
    memory_bundle_sha256, resolve_memory_path,
};
use crate::memory_dialects::MemoryDialect;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use memoar_canonical::MemoryScope;

fn file(path: &str, text: &str) -> MemoryBundleFile {
    MemoryBundleFile {
        path: path.to_owned(),
        media_type: "text/markdown".to_owned(),
        base64: BASE64.encode(text.as_bytes()),
        sha256: content_sha256(text.as_bytes()),
        size: text.len() as u64,
        sources: vec!["/Users/x/.claude/CLAUDE.md".to_owned()],
    }
}

fn bundle(
    target: MemoryDialect,
    scope: MemoryScope,
    files: Vec<MemoryBundleFile>,
) -> MemoryConversionBundle {
    let mut bundle = MemoryConversionBundle {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        bundle_version: "1".to_owned(),
        kind: "memory".to_owned(),
        source: "claude-code".to_owned(),
        target,
        scope,
        workspace_path: None,
        report: MemoryConversionReport {
            documents: files.len() as u64,
            concatenated: false,
        },
        files,
        bundle_sha256: String::new(),
    };
    bundle.bundle_sha256 = memory_bundle_sha256(&bundle).expect("digest");
    bundle
}

#[test]
fn writes_the_port_to_the_path_the_target_tool_reads() {
    let temp = tempfile::tempdir().unwrap();
    let converted = bundle(
        MemoryDialect::Codex,
        MemoryScope::Global,
        vec![file("~/.codex/AGENTS.md", "Small files. Real coverage.\n")],
    );

    let result = materialize_memory_bundle(&converted, temp.path(), None).expect("materialize");
    let written = temp.path().join(".codex/AGENTS.md");
    assert_eq!(result.written, vec![written.clone()]);
    assert_eq!(
        fs::read_to_string(&written).unwrap(),
        "Small files. Real coverage.\n",
        "a mechanical port moves the bytes and nothing else"
    );
}

/// The destination is the containment. A session bundle needs its session id in
/// the path because `~/.claude/projects/**` is a large space; a memory file
/// lands at one literal per dialect and scope, looked up here and never read
/// from the bundle, so there is nothing for an id to add.
#[test]
fn refuses_every_path_that_is_not_the_dialect_literal() {
    let temp = tempfile::tempdir().unwrap();
    for hostile in [
        "~/.codex/AGENTS.md.bak",
        "~/.codex/agents.md",
        "~/.ssh/authorized_keys",
        "~/.codex/../.ssh/authorized_keys",
        "~/./.codex/AGENTS.md",
        "~/.codex\\AGENTS.md",
        "/root/.codex/AGENTS.md",
        "./.codex/AGENTS.md",
        ".codex/AGENTS.md",
        "~/",
    ] {
        let error = resolve_memory_path(
            temp.path(),
            hostile,
            MemoryDialect::Codex,
            &MemoryScope::Global,
        )
        .expect_err(&format!("{hostile} should not resolve"));
        assert!(
            matches!(error, MaterializeError::UnsafePath(_)),
            "{hostile} refused for the wrong reason: {error}"
        );
    }
    assert!(
        resolve_memory_path(
            temp.path(),
            "~/.codex/AGENTS.md",
            MemoryDialect::Codex,
            &MemoryScope::Global
        )
        .is_ok(),
        "the one allowed path must still resolve"
    );
}

#[test]
fn allows_only_one_plain_name_inside_a_rules_directory() {
    let temp = tempfile::tempdir().unwrap();
    let resolve = |path: &str| {
        resolve_memory_path(temp.path(), path, MemoryDialect::Roo, &MemoryScope::Global)
    };
    assert!(resolve("~/.roo/rules/users-x-claude-claude-md.md").is_ok());
    for hostile in [
        "~/.roo/rules/nested/file.md",
        "~/.roo/rules/.hidden.md",
        "~/.roo/rules/File.md",
        "~/.roo/rules/file.txt",
        "~/.roo/rules/file.md.sh",
        "~/.roo/rules/-leading.md",
        "~/.roo/rules/.md",
        "~/.roo/rules",
        "~/.roo/file.md",
    ] {
        assert!(
            resolve(hostile).is_err(),
            "{hostile} should not resolve inside a rules directory"
        );
    }
}

#[test]
fn will_not_replace_a_file_somebody_wrote_themselves() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join(".codex")).unwrap();
    fs::write(temp.path().join(".codex/AGENTS.md"), "Mine, thanks.\n").unwrap();
    let converted = bundle(
        MemoryDialect::Codex,
        MemoryScope::Global,
        vec![file("~/.codex/AGENTS.md", "Ported.\n")],
    );

    let error = materialize_memory_bundle(&converted, temp.path(), None)
        .expect_err("an existing AGENTS.md is not ours to replace");
    assert!(matches!(error, MaterializeError::Collision(_)), "{error}");
    assert_eq!(
        fs::read_to_string(temp.path().join(".codex/AGENTS.md")).unwrap(),
        "Mine, thanks.\n"
    );
}

#[test]
fn converting_twice_writes_nothing_the_second_time() {
    let temp = tempfile::tempdir().unwrap();
    let converted = bundle(
        MemoryDialect::Codex,
        MemoryScope::Global,
        vec![file("~/.codex/AGENTS.md", "Ported.\n")],
    );

    materialize_memory_bundle(&converted, temp.path(), None).expect("first");
    let again = materialize_memory_bundle(&converted, temp.path(), None).expect("second");
    assert!(again.written.is_empty(), "the same bytes are not a change");
    assert_eq!(again.unchanged.len(), 1);
}

#[test]
fn a_project_port_needs_the_workspace_it_belongs_to() {
    let temp = tempfile::tempdir().unwrap();
    let converted = bundle(
        MemoryDialect::Goose,
        MemoryScope::Project,
        vec![file("./.goosehints", "Project rules.\n")],
    );

    let error = materialize_memory_bundle(&converted, temp.path(), None)
        .expect_err("a workspace is not something to guess at");
    assert!(
        matches!(error, MaterializeError::MissingWorkspace),
        "{error}"
    );

    let workspace = tempfile::tempdir().unwrap();
    let result = materialize_memory_bundle(&converted, temp.path(), Some(workspace.path()))
        .expect("materialize into the named workspace");
    assert_eq!(result.written, vec![workspace.path().join(".goosehints")]);
}

/// The other half of the two-language agreement.
///
/// `server/test/memory-dialect-parity.test.ts` holds the archive to this exact
/// file, so the server cannot change a byte of what it writes without changing
/// this fixture, and this test then fails unless the digest computed here still
/// matches. Without it the two sides agree until somebody reorders a field, and
/// then every conversion fails on a user's machine and none of them in CI.
#[test]
fn materializes_the_committed_server_bundle() {
    let temp = tempfile::tempdir().unwrap();
    let converted: MemoryConversionBundle = serde_json::from_str(include_str!(
        "../../../../../contracts/fixtures/memory-conversion-bundle.json"
    ))
    .expect("the committed bundle must parse as one");
    assert_eq!(
        memory_bundle_sha256(&converted).unwrap(),
        converted.bundle_sha256,
        "the archive and this crate disagree about the manifest digest"
    );

    let result = materialize_memory_bundle(&converted, temp.path(), None).expect("materialize");
    assert_eq!(result.written, vec![temp.path().join(".codex/AGENTS.md")]);
    let text = fs::read_to_string(temp.path().join(".codex/AGENTS.md")).unwrap();
    assert!(text.contains("<!-- memoar: from /Users/x/.claude/CLAUDE.md -->"));
    assert!(text.contains("Frane prefers domain modules."));
}

#[test]
fn refuses_a_bundle_whose_digest_does_not_match_what_it_carries() {
    let temp = tempfile::tempdir().unwrap();
    let mut converted = bundle(
        MemoryDialect::Codex,
        MemoryScope::Global,
        vec![file("~/.codex/AGENTS.md", "Ported.\n")],
    );
    converted.files[0].base64 = BASE64.encode(b"Something else entirely.\n");

    let error = materialize_memory_bundle(&converted, temp.path(), None)
        .expect_err("the manifest and the bytes must agree");
    assert!(matches!(error, MaterializeError::Integrity(_)), "{error}");
    assert!(!temp.path().join(".codex/AGENTS.md").exists());
}
