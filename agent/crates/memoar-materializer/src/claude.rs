//! Writing a canonical session out as Claude Code's native transcript.

use serde_json::{Value, json};
use std::path::Path;

use crate::bundle::{MaterializationResult, MaterializedReport, PlannedFile};
use crate::commit::commit_plan;
use crate::error::MaterializeError;
use crate::native::{degraded_text, encode_claude_workspace, json_lines, report};
use crate::target::Target;
use memoar_canonical::{ContentBlock, ContentBlockKind, Session};

pub(crate) fn materialize_claude(
    session: &Session,
    home: &Path,
) -> Result<MaterializationResult, MaterializeError> {
    let encoded_workspace = encode_claude_workspace(&session.workspace.path);
    let path = home
        .join(".claude/projects")
        .join(encoded_workspace)
        .join(format!("{}.jsonl", session.id));
    let mut records = Vec::with_capacity(session.turns.len());
    let mut degraded = 0;
    for turn in &session.turns {
        let content: Vec<_> = turn
            .blocks
            .iter()
            .map(|block| claude_block(block, &mut degraded))
            .collect();
        records.push(json!({
            "uuid": turn.id,
            "parentUuid": turn.parent_id,
            "sessionId": session.id,
            "type": turn.role,
            "message": { "role": turn.role, "content": content },
            "timestamp": turn.created_at,
            "cwd": session.workspace.path,
            "memoar": { "contractVersion": memoar_canonical::CONTRACT_VERSION }
        }));
    }
    let bytes = json_lines(&records)?;
    let (written, unchanged) = commit_plan(home, &[PlannedFile { path, bytes }])?;
    Ok(MaterializationResult {
        target: Target::ClaudeCode,
        session_id: session.id.clone(),
        written,
        unchanged,
        resume_command: format!("claude -r {}", session.id),
        report: MaterializedReport::Local(report(session, degraded)),
    })
}

fn claude_block(block: &ContentBlock, degraded: &mut usize) -> Value {
    match block.kind {
        ContentBlockKind::Text => {
            json!({ "type": "text", "text": block.text.clone().unwrap_or_default() })
        }
        ContentBlockKind::Thinking => {
            json!({ "type": "thinking", "thinking": block.text.clone().unwrap_or_default() })
        }
        ContentBlockKind::ToolCall => json!({
            "type": "tool_use",
            "id": block.call_id.clone().unwrap_or_else(|| block.id.clone()),
            "name": block.name.clone().unwrap_or_else(|| "memoar_tool".to_owned()),
            "input": block.data.clone().unwrap_or_default()
        }),
        ContentBlockKind::ToolResult => json!({
            "type": "tool_result",
            "tool_use_id": block.call_id.clone().unwrap_or_else(|| block.id.clone()),
            "content": block.text.clone().unwrap_or_default()
        }),
        _ => {
            *degraded += 1;
            json!({ "type": "text", "text": degraded_text(block) })
        }
    }
}
