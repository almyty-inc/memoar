//! Writing a canonical session out as Claude Code's native transcript.

use serde_json::json;
use std::path::Path;

use crate::bundle::{MaterializationResult, MaterializedReport, PlannedFile};
use crate::claude_blocks::claude_block;
use crate::commit::commit_plan;
use crate::error::MaterializeError;
use crate::native::{encode_claude_workspace, json_lines, report};
use crate::target::Target;
use memoar_canonical::Session;

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
