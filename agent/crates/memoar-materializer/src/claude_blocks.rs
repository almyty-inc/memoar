//! Canonical blocks as Claude Code's native message content.
//!
//! The parser keeps what a native block held in the canonical fields: a tool
//! result's prose in `text`, its error flag and any image it returned in
//! `data.isError` and `data.content`, a thinking block's signature in
//! `data.signature`, a redacted one's payload in `data.redacted` and
//! `data.data`, and an image's bytes in `data.source`. Writing only `text`
//! back meant a converted session lost every one of those, so a tool result
//! that had returned a screenshot came back as words, and an error as a
//! success.

use serde_json::{Map, Value, json};

use crate::native::degraded_text;
use memoar_canonical::{ContentBlock, ContentBlockKind};

fn data_value<'a>(block: &'a ContentBlock, key: &str) -> Option<&'a Value> {
    block.data.as_ref().and_then(|data| data.get(key))
}

fn thinking(block: &ContentBlock) -> Value {
    if data_value(block, "redacted") == Some(&Value::Bool(true)) {
        let payload = data_value(block, "data").cloned().unwrap_or(Value::Null);
        return json!({ "type": "redacted_thinking", "data": payload });
    }
    let mut native = Map::new();
    native.insert("type".to_owned(), json!("thinking"));
    native.insert(
        "thinking".to_owned(),
        json!(block.text.clone().unwrap_or_default()),
    );
    if let Some(signature) = data_value(block, "signature") {
        native.insert("signature".to_owned(), signature.clone());
    }
    Value::Object(native)
}

fn tool_result(block: &ContentBlock) -> Value {
    // An array that held anything besides prose is written back whole, so an
    // image a tool returned is returned again.
    let content = match data_value(block, "content") {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        _ => json!(block.text.clone().unwrap_or_default()),
    };
    let mut native = Map::new();
    native.insert("type".to_owned(), json!("tool_result"));
    native.insert(
        "tool_use_id".to_owned(),
        json!(block.call_id.clone().unwrap_or_else(|| block.id.clone())),
    );
    native.insert("content".to_owned(), content);
    if data_value(block, "isError") == Some(&Value::Bool(true)) {
        native.insert("is_error".to_owned(), json!(true));
    }
    Value::Object(native)
}

/// An image or a document, if the block still holds its bytes or a URL.
fn attachment(block: &ContentBlock) -> Option<Value> {
    let source = match data_value(block, "source") {
        Some(source @ Value::Object(_)) => source.clone(),
        _ => {
            let url = block.artifact_ref.as_ref().filter(|reference| {
                reference.starts_with("https://") || reference.starts_with("http://")
            })?;
            json!({ "type": "url", "url": url })
        }
    };
    let media_type = block
        .mime_type
        .clone()
        .or_else(|| {
            source
                .get("media_type")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default();
    let kind = if media_type.starts_with("image/") {
        "image"
    } else {
        "document"
    };
    let mut native = Map::new();
    native.insert("type".to_owned(), json!(kind));
    native.insert("source".to_owned(), source);
    if let (Some(title), "document") = (&block.name, kind) {
        native.insert("title".to_owned(), json!(title));
    }
    Some(Value::Object(native))
}

pub(crate) fn claude_block(block: &ContentBlock, degraded: &mut usize) -> Value {
    match block.kind {
        ContentBlockKind::Text => {
            json!({ "type": "text", "text": block.text.clone().unwrap_or_default() })
        }
        ContentBlockKind::Thinking => thinking(block),
        ContentBlockKind::ToolCall => json!({
            "type": "tool_use",
            "id": block.call_id.clone().unwrap_or_else(|| block.id.clone()),
            "name": block.name.clone().unwrap_or_else(|| "memoar_tool".to_owned()),
            "input": block.data.clone().unwrap_or_default()
        }),
        ContentBlockKind::ToolResult => tool_result(block),
        ContentBlockKind::Attachment => attachment(block).unwrap_or_else(|| {
            *degraded += 1;
            json!({ "type": "text", "text": degraded_text(block) })
        }),
        _ => {
            *degraded += 1;
            json!({ "type": "text", "text": degraded_text(block) })
        }
    }
}
