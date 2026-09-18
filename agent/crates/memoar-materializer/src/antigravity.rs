//! Writing a canonical session out as Antigravity's brain database.

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use uuid::Uuid;

use crate::bundle::{MaterializationResult, MaterializedReport, PlannedFile};
use crate::commit::commit_plan;
use crate::error::MaterializeError;
use crate::native::{degraded_text, json_lines, report};
use crate::target::Target;
use memoar_canonical::{ContentBlock, ContentBlockKind, Session};

pub(crate) fn materialize_antigravity(
    session: &Session,
    home: &Path,
) -> Result<MaterializationResult, MaterializeError> {
    let brain = home.join(".gemini/antigravity-cli/brain").join(&session.id);
    let transcript = brain.join(".system_generated/logs/transcript.jsonl");
    let database = brain
        .join("conversations")
        .join(format!("{}.db", session.id));
    let walkthrough = brain.join("walkthrough.md");
    let mut records = Vec::with_capacity(session.turns.len());
    let mut degraded = 0;
    for turn in &session.turns {
        let parts: Vec<_> = turn
            .blocks
            .iter()
            .map(|block| antigravity_block(block, &mut degraded))
            .collect();
        records.push(json!({
            "type": "message",
            "id": turn.id,
            "parentId": turn.parent_id,
            "role": turn.role,
            "parts": parts,
            "createdAt": turn.created_at
        }));
    }
    let report = report(session, degraded);
    let summary = format!(
        "# Memoar conversion\n\nSession: `{}`\n\nMapped turns: {}\n\nDegraded blocks: {}\n\nDropped blocks: 0\n",
        session.id, report.mapped_turns, report.degraded_blocks
    );
    let seed = serde_json::to_vec(&json!({
        "id": session.id,
        "workspacePath": session.workspace.path,
        "title": session.title,
        "createdAt": session.created_at,
        "updatedAt": session.updated_at
    }))?;
    let planned = vec![
        PlannedFile {
            path: transcript,
            bytes: json_lines(&records)?,
        },
        PlannedFile {
            path: database,
            bytes: antigravity_database_bytes(&session.id, &seed)?,
        },
        PlannedFile {
            path: walkthrough,
            bytes: summary.into_bytes(),
        },
    ];
    let (written, unchanged) = commit_plan(home, &planned)?;
    Ok(MaterializationResult {
        target: Target::AntigravityCli,
        session_id: session.id.clone(),
        written,
        unchanged,
        resume_command: format!("agy --conversation {}", session.id),
        report: MaterializedReport::Local(report),
    })
}

fn antigravity_block(block: &ContentBlock, degraded: &mut usize) -> Value {
    match block.kind {
        ContentBlockKind::Text => {
            json!({ "type": "text", "text": block.text.clone().unwrap_or_default() })
        }
        ContentBlockKind::Thinking => {
            json!({ "type": "thought", "text": block.text.clone().unwrap_or_default() })
        }
        ContentBlockKind::ToolCall => json!({
            "type": "tool_call",
            "id": block.call_id.clone().unwrap_or_else(|| block.id.clone()),
            "name": block.name,
            "arguments": block.data
        }),
        ContentBlockKind::ToolResult => json!({
            "type": "tool_result",
            "id": block.call_id.clone().unwrap_or_else(|| block.id.clone()),
            "text": block.text
        }),
        _ => {
            *degraded += 1;
            json!({ "type": "text", "text": degraded_text(block), "memoarDegraded": true })
        }
    }
}

pub(crate) fn antigravity_database_bytes(
    session_id: &str,
    seed_bytes: &[u8],
) -> Result<Vec<u8>, MaterializeError> {
    let seed: Value = serde_json::from_slice(seed_bytes).unwrap_or_else(|_| json!({}));
    let temp = std::env::temp_dir().join(format!("memoar-antigravity-{}.db", Uuid::now_v7()));
    let build = (|| -> Result<Vec<u8>, MaterializeError> {
        let connection = Connection::open(&temp)?;
        connection.execute_batch(
            "PRAGMA user_version = 1;
             PRAGMA journal_mode = DELETE;
             CREATE TABLE trajectory_meta (
               trajectory_id TEXT PRIMARY KEY,
               cascade_id TEXT,
               trajectory_type INTEGER,
               source INTEGER
             );
             CREATE TABLE steps (
               idx INTEGER PRIMARY KEY,
               step_type INTEGER DEFAULT 0,
               status INTEGER DEFAULT 0,
               has_subtrajectory NUMERIC DEFAULT 0,
               metadata BLOB,
               error_details BLOB,
               permissions BLOB,
               task_details BLOB,
               render_info BLOB,
               step_payload BLOB,
               step_format INTEGER DEFAULT 0
             );
             CREATE INDEX idx_steps_status ON steps(status);
             CREATE INDEX idx_steps_step_type ON steps(step_type);
             CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);
             CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
             CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
             CREATE TABLE trajectory_metadata_blob (
               id TEXT PRIMARY KEY DEFAULT 'main', data BLOB
             );
             CREATE TABLE battle_mode_infos (idx INTEGER PRIMARY KEY, data BLOB);
             CREATE TABLE memoar_conversion (
               id TEXT PRIMARY KEY,
               workspace_path TEXT,
               title TEXT,
               contract_version TEXT NOT NULL,
               source_seed BLOB NOT NULL
             );",
        )?;
        connection.execute(
            "INSERT INTO trajectory_meta
             (trajectory_id, cascade_id, trajectory_type, source) VALUES (?1, ?1, 0, 0)",
            [session_id],
        )?;
        connection.execute(
            "INSERT INTO memoar_conversion
             (id, workspace_path, title, contract_version, source_seed)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                session_id,
                seed.get("workspacePath").and_then(Value::as_str),
                seed.get("title").and_then(Value::as_str),
                memoar_canonical::CONTRACT_VERSION,
                seed_bytes,
            ],
        )?;
        connection.execute_batch("PRAGMA optimize;")?;
        drop(connection);
        fs::read(&temp).map_err(|source| MaterializeError::Io {
            path: temp.clone(),
            source,
        })
    })();
    let _ = fs::remove_file(&temp);
    build
}

pub(crate) fn validate_antigravity_database(
    bytes: &[u8],
    session_id: &str,
) -> Result<(), MaterializeError> {
    if !bytes.starts_with(b"SQLite format 3\0") {
        return Err(MaterializeError::Integrity(
            "Antigravity database is not SQLite".to_owned(),
        ));
    }
    let temp = std::env::temp_dir().join(format!("memoar-validate-{}.db", Uuid::now_v7()));
    let result = (|| -> Result<(), MaterializeError> {
        fs::write(&temp, bytes).map_err(|source| MaterializeError::Io {
            path: temp.clone(),
            source,
        })?;
        let connection = Connection::open(&temp)?;
        let integrity: String =
            connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(MaterializeError::Integrity(format!(
                "Antigravity SQLite integrity check returned {integrity}"
            )));
        }
        let trajectory: String = connection
            .query_row(
                "SELECT trajectory_id FROM trajectory_meta LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| {
                MaterializeError::Integrity(format!(
                    "Antigravity database lacks trajectory_meta: {error}"
                ))
            })?;
        if trajectory != session_id {
            return Err(MaterializeError::Integrity(format!(
                "Antigravity trajectory {trajectory} does not match session {session_id}"
            )));
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temp);
    result
}
