//! Writing a canonical session out as Codex's native rollout.

use chrono::Datelike;
use serde_json::{Value, json};
use std::path::Path;

use crate::bundle::{MaterializationResult, MaterializedReport, PlannedFile};
use crate::commit::commit_plan;
use crate::error::MaterializeError;
use crate::native::{degraded_text, json_lines, parse_time, report};
use crate::target::Target;
use memoar_canonical::{ContentBlock, ContentBlockKind, Session};

pub(crate) fn materialize_codex(
    session: &Session,
    home: &Path,
) -> Result<MaterializationResult, MaterializeError> {
    let created_at = parse_time(&session.created_at);
    let filename = format!(
        "rollout-{}-{}.jsonl",
        created_at.format("%Y-%m-%dT%H-%M-%S"),
        session.id
    );
    let path = home
        .join(".codex/sessions")
        .join(created_at.year().to_string())
        .join(format!("{:02}", created_at.month()))
        .join(format!("{:02}", created_at.day()))
        .join(filename);
    let mut records = Vec::with_capacity(session.turns.len() + 1);
    records.push(json!({
        "timestamp": session.created_at,
        "type": "session_meta",
        "payload": {
            "id": session.id,
            "cwd": session.workspace.path,
            "originator": "memoar",
            "cli_version": memoar_canonical::CONTRACT_VERSION,
            "source": "conversion"
        }
    }));
    let mut degraded = 0;
    for turn in &session.turns {
        let content: Vec<_> = turn
            .blocks
            .iter()
            .map(|block| codex_block(block, &turn.role, &mut degraded))
            .collect();
        records.push(json!({
            "timestamp": turn.created_at,
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": turn.id,
                "role": turn.role,
                "content": content,
                "memoar_parent_id": turn.parent_id
            }
        }));
    }
    let bytes = json_lines(&records)?;
    let (written, unchanged) = commit_plan(home, &[PlannedFile { path, bytes }])?;
    Ok(MaterializationResult {
        target: Target::Codex,
        session_id: session.id.clone(),
        written,
        unchanged,
        resume_command: format!("codex resume {}", session.id),
        report: MaterializedReport::Local(report(session, degraded)),
    })
}

fn codex_block(block: &ContentBlock, role: &str, degraded: &mut usize) -> Value {
    let block_type = if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    };
    match block.kind {
        ContentBlockKind::Text => {
            json!({ "type": block_type, "text": block.text.clone().unwrap_or_default() })
        }
        _ => {
            *degraded += 1;
            json!({ "type": block_type, "text": degraded_text(block) })
        }
    }
}
