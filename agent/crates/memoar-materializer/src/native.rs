//! Shared helpers for the native writers.

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::bundle::{ConversionReport, content_sha256};
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

/// The longest directory component this will produce.
///
/// A path component is capped at 255 bytes on APFS and ext4, and the encoding
/// below turns a whole absolute path into exactly one component. Nothing
/// bounded it, so a session captured from a deep workspace failed at the write
/// with `File name too long (os error 63)` — reported as MEMOAR_UNKNOWN, whose
/// hint is to run `memoar doctor`, which cannot help. Worse, re-archiving such
/// a session encodes the already-encoded path again, so the name grows every
/// round.
///
/// 180 leaves room for the session id and extension that follow it.
const MAX_WORKSPACE_COMPONENT: usize = 180;

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
        return "memoar-imports".to_owned();
    }
    if encoded.len() <= MAX_WORKSPACE_COMPONENT {
        return encoded;
    }
    // The tail is kept because that is where the project is named; the digest of
    // the whole path goes in front so two long workspaces sharing a tail do not
    // land in one directory.
    let digest = content_sha256(workspace.as_bytes());
    let keep = MAX_WORKSPACE_COMPONENT - 13;
    let tail: String = encoded
        .char_indices()
        .skip_while(|(index, _)| encoded.len() - index > keep)
        .map(|(_, character)| character)
        .collect();
    format!("{}-{tail}", &digest[..12])
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
