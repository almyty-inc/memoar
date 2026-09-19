//! What a block still says after the target could not hold its shape.

use std::collections::BTreeMap;
use std::fs;

use super::fixtures::fixture_session;
use crate::entry::materialize;
use crate::target::Target;
use memoar_canonical::{ContentBlock, ContentBlockKind};

fn block(kind: ContentBlockKind) -> ContentBlock {
    ContentBlock {
        id: "0198d8d0-977c-777b-9f8f-0f6d8416e7aa".to_owned(),
        kind,
        text: None,
        name: None,
        call_id: None,
        language: None,
        mime_type: None,
        artifact_ref: None,
        data: None,
        ext: None,
    }
}

/// Degraded means the shape was lost, not the content.
///
/// Codex has no native tool shape, so every tool call is degraded into text.
/// Only `text` was read, and a tool call has none — so `git push --force` went
/// in and `[memoar converted tool_call] ` came out, with the tool's name and
/// arguments gone and the conversion reporting one *degraded* block and zero
/// dropped ones.
#[test]
fn a_degraded_block_keeps_what_it_had() {
    let mut arguments = BTreeMap::new();
    arguments.insert(
        "command".to_owned(),
        serde_json::Value::String("git push --force".to_owned()),
    );

    let mut call = block(ContentBlockKind::ToolCall);
    call.name = Some("Bash".to_owned());
    call.data = Some(arguments);

    let mut artifact = block(ContentBlockKind::Artifact);
    artifact.artifact_ref = Some("sha256:c0ffee".to_owned());

    let mut attachment = block(ContentBlockKind::Attachment);
    let mut payload = BTreeMap::new();
    payload.insert(
        "filename".to_owned(),
        serde_json::Value::String("design.png".to_owned()),
    );
    attachment.data = Some(payload);

    let mut session = fixture_session();
    session.turns[0].blocks = vec![call, artifact, attachment];

    let temp = tempfile::tempdir().unwrap();
    let result = materialize(&session, Target::Codex, temp.path()).expect("materialize");
    let written = fs::read_to_string(&result.written[0]).unwrap();

    assert!(
        written.contains("[memoar converted tool_call] Bash"),
        "the tool's name is the least a degraded call can say: {written}"
    );
    assert!(
        written.contains("[memoar converted artifact] sha256:c0ffee"),
        "an artifact with no text is its reference: {written}"
    );
    assert!(
        written.contains("design.png"),
        "an attachment with neither text nor reference still has its data: {written}"
    );
    assert!(
        !written.contains("[memoar converted tool_call] \""),
        "no degraded block may render as an empty marker: {written}"
    );
}
