//! Shared helpers for the native writers.

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::bundle::ConversionReport;
use crate::error::MaterializeError;
use memoar_canonical::{ContentBlock, ContentBlockKind, Session};

pub(crate) fn json_lines(records: &[Value]) -> Result<Vec<u8>, MaterializeError> {
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, record)?;
        bytes.push(b'\n');
    }
    Ok(bytes)
}

pub(crate) fn encode_claude_workspace(workspace: &str) -> String {
    let encoded: String = workspace
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '-',
            value if value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.') => value,
            _ => '-',
        })
        .collect();
    if encoded.is_empty() {
        "memoar-imports".to_owned()
    } else {
        encoded
    }
}

pub(crate) fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

pub(crate) fn degraded_text(block: &ContentBlock) -> String {
    let kind = match block.kind {
        ContentBlockKind::Text => "text",
        ContentBlockKind::Thinking => "thinking",
        ContentBlockKind::ToolCall => "tool_call",
        ContentBlockKind::ToolResult => "tool_result",
        ContentBlockKind::Diff => "diff",
        ContentBlockKind::Artifact => "artifact",
        ContentBlockKind::Attachment => "attachment",
        ContentBlockKind::System => "system",
        ContentBlockKind::Error => "error",
    };
    format!(
        "[memoar converted {kind}] {}",
        block.text.clone().unwrap_or_default()
    )
}

pub(crate) fn report(session: &Session, degraded_blocks: usize) -> ConversionReport {
    ConversionReport {
        mapped_turns: session.turns.len(),
        degraded_blocks,
        dropped_blocks: 0,
    }
}
