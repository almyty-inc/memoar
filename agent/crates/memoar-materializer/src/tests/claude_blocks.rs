//! A converted Claude Code session gives back what the parser kept.

use std::collections::BTreeMap;
use std::fs;

use serde_json::{Value, json};

use super::fixtures::fixture_session;
use crate::entry::materialize;
use crate::target::Target;
use memoar_canonical::{ContentBlock, ContentBlockKind};

fn block(id: &str, kind: ContentBlockKind) -> ContentBlock {
    ContentBlock {
        id: id.to_owned(),
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

fn data(pairs: &[(&str, Value)]) -> Option<BTreeMap<String, Value>> {
    Some(
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect(),
    )
}

/// The content array the materializer wrote for the first turn.
fn written_content(blocks: Vec<ContentBlock>) -> (Vec<Value>, usize) {
    let mut session = fixture_session();
    session.turns[0].blocks = blocks;
    let temp = tempfile::tempdir().unwrap();
    let result = materialize(&session, Target::ClaudeCode, temp.path()).expect("materialize");
    let written = fs::read_to_string(&result.written[0]).unwrap();
    let first: Value = serde_json::from_str(written.lines().next().unwrap()).unwrap();
    let degraded = match result.report {
        crate::bundle::MaterializedReport::Local(report) => report.degraded_blocks,
        _ => 0,
    };
    (
        first["message"]["content"].as_array().unwrap().clone(),
        degraded,
    )
}

#[test]
fn a_tool_result_comes_back_with_its_content_error_flag_and_image() {
    let image = json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo=" } });
    let mut with_image = block(
        "0198d8d0-977c-777b-9f8f-0f6d8416e7b1",
        ContentBlockKind::ToolResult,
    );
    with_image.call_id = Some("toolu_shot".to_owned());
    with_image.text = Some("the screenshot tool timed out".to_owned());
    with_image.data = data(&[
        ("isError", json!(true)),
        (
            "content",
            json!([{ "type": "text", "text": "the screenshot tool timed out" }, image]),
        ),
    ]);
    let mut plain = block(
        "0198d8d0-977c-777b-9f8f-0f6d8416e7b2",
        ContentBlockKind::ToolResult,
    );
    plain.call_id = Some("toolu_read".to_owned());
    plain.text = Some("export function parse() {}".to_owned());

    let (content, degraded) = written_content(vec![with_image, plain]);

    assert_eq!(content[0]["tool_use_id"], "toolu_shot");
    assert_eq!(content[0]["is_error"], true);
    assert_eq!(
        content[0]["content"][1]["source"]["media_type"],
        "image/png"
    );
    assert_eq!(content[1]["content"], "export function parse() {}");
    assert!(content[1].get("is_error").is_none());
    assert_eq!(degraded, 0);
}

#[test]
fn thinking_keeps_its_signature_and_redacted_thinking_its_payload() {
    let mut signed = block(
        "0198d8d0-977c-777b-9f8f-0f6d8416e7b3",
        ContentBlockKind::Thinking,
    );
    signed.text = Some("weighing the options".to_owned());
    signed.data = data(&[("signature", json!("c2lnbmF0dXJl"))]);
    let mut redacted = block(
        "0198d8d0-977c-777b-9f8f-0f6d8416e7b4",
        ContentBlockKind::Thinking,
    );
    redacted.data = data(&[("redacted", json!(true)), ("data", json!("b3BhcXVl"))]);

    let (content, _) = written_content(vec![signed, redacted]);

    assert_eq!(
        content[0],
        json!({ "type": "thinking", "thinking": "weighing the options", "signature": "c2lnbmF0dXJl" })
    );
    assert_eq!(
        content[1],
        json!({ "type": "redacted_thinking", "data": "b3BhcXVl" })
    );
}

#[test]
fn an_image_with_its_bytes_is_an_image_again_and_one_without_is_degraded() {
    let mut image = block(
        "0198d8d0-977c-777b-9f8f-0f6d8416e7b5",
        ContentBlockKind::Attachment,
    );
    image.mime_type = Some("image/png".to_owned());
    image.data = data(&[(
        "source",
        json!({ "type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo=" }),
    )]);
    let mut lost = block(
        "0198d8d0-977c-777b-9f8f-0f6d8416e7b6",
        ContentBlockKind::Attachment,
    );
    lost.name = Some("notes.md".to_owned());

    let (content, degraded) = written_content(vec![image, lost]);

    assert_eq!(content[0]["type"], "image");
    assert_eq!(content[0]["source"]["data"], "iVBORw0KGgo=");
    assert_eq!(content[1]["type"], "text");
    assert_eq!(degraded, 1);
}
