//! Made-up sessions for the TUI tests. No real person, path or credential.

use serde_json::{Value, json};

pub(crate) const FIRST: &str = "0198d8d0-977c-777b-9f8f-0f6d8416e900";
pub(crate) const SECOND: &str = "0198d8d0-977c-777b-9f8f-0f6d8416e901";
pub(crate) const THIRD: &str = "0198d8d0-977c-777b-9f8f-0f6d8416e902";

pub(crate) fn summary(id: &str, title: &str, updated_at: &str, turns: u64) -> Value {
    json!({
        "id": id,
        "title": title,
        "source": "claude-code",
        "sourceLabel": "Claude Code",
        "machineId": "0198d8d0-977c-777b-9f8f-0f6d8416e700",
        "workspace": "/workspace/example-app",
        "updatedAt": updated_at,
        "turnCount": turns,
        "tokenCount": 0,
        "redactionStatus": "clear"
    })
}

pub(crate) fn page() -> Value {
    json!({
        "items": [
            summary(FIRST, "Fix the importer", "2026-08-20T09:00:00Z", 4),
            summary(SECOND, "Add a search index", "2026-08-20T08:00:00Z", 1),
            summary(THIRD, "Write release notes", "2026-08-18T10:00:00Z", 12)
        ],
        "total": 3,
        "nextCursor": null
    })
}

pub(crate) fn turns() -> Vec<Value> {
    serde_json::from_value(json!([
        {
            "role": "user",
            "createdAt": "2026-08-20T09:00:00Z",
            "blocks": [{ "kind": "text", "text": "Why does the importer drop tool output?" }]
        },
        {
            "role": "assistant",
            "createdAt": "2026-08-20T09:01:00Z",
            "blocks": [
                { "kind": "thinking", "text": "It probably copies only the text field." },
                { "kind": "text", "text": "I will read the parser.\n\n```rust\nfn parse() -> u32 { 42 }\n```" },
                { "kind": "tool_call", "name": "Read", "callId": "call-read", "data": { "file_path": "/workspace/example-app/src/parser.rs" } },
                { "kind": "tool_call", "name": "Bash", "callId": "call-test", "data": { "command": "cargo test parser" } },
                { "kind": "tool_call", "name": "Edit", "callId": "call-edit", "data": {
                    "file_path": "/workspace/example-app/src/parser.rs",
                    "old_string": "keep\ncopy_text_only()\nend",
                    "new_string": "keep\ncopy_every_field()\nend"
                } }
            ]
        },
        {
            "role": "user",
            "createdAt": "2026-08-20T09:02:00Z",
            "blocks": [
                { "kind": "tool_result", "callId": "call-read", "text": "line one\nline two\nline three" },
                { "kind": "tool_result", "callId": "call-test", "text": "running 1 test\ntest parser ... ok" },
                { "kind": "tool_result", "callId": "call-edit", "text": "edited" }
            ]
        }
    ]))
    .unwrap()
}

pub(crate) fn chunk(id: &str) -> Value {
    json!({
        "session": summary(id, "Fix the importer", "2026-08-20T09:00:00Z", 4),
        "turns": turns(),
        "provenance": [],
        "nextCursor": null
    })
}
