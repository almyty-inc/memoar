//! Native session bundle materialization for gated conversion targets.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, Datelike, Utc};
use memoar_canonical::{ContentBlock, ContentBlockKind, Session};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;
use thiserror::Error;
use uuid::Uuid;

const MAX_BUNDLE_FILE_BYTES: usize = 512 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum MaterializeError {
    #[error("unsupported conversion target: {0}")]
    UnsupportedTarget(String),
    #[error("invalid session id: {0}")]
    InvalidSessionId(String),
    #[error("unsafe bundle path: {0}")]
    UnsafePath(String),
    #[error("refusing to overwrite existing native session at {0}")]
    Collision(PathBuf),
    #[error("could not write {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("could not encode native record: {0}")]
    Json(#[from] serde_json::Error),
    #[error("could not decode bundle file {path}: {message}")]
    Decode { path: String, message: String },
    #[error("bundle integrity check failed: {0}")]
    Integrity(String),
    #[error("could not build Antigravity conversation database: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("bundle contract version {0} is not supported")]
    ContractVersion(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Target {
    ClaudeCode,
    Codex,
    AntigravityCli,
}

impl Target {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::AntigravityCli => "antigravity-cli",
        }
    }
}

impl FromStr for Target {
    type Err = MaterializeError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            "antigravity-cli" => Ok(Self::AntigravityCli),
            other => Err(MaterializeError::UnsupportedTarget(other.to_owned())),
        }
    }
}

/// Server download wire format. It intentionally carries already-serialized
/// native files so CLI and remote-machine materializers use one path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionBundle {
    pub contract_version: String,
    pub bundle_version: String,
    pub bundle_sha256: String,
    pub target: Target,
    pub session_id: String,
    pub files: Vec<BundleFile>,
    pub resume_command: String,
    #[serde(default)]
    pub report: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleFile {
    pub path: String,
    pub media_type: String,
    pub base64: String,
    pub sha256: String,
    pub size: u64,
}

/// Local/testing form retained for deterministic canonical-to-native writers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalConversionBundle {
    pub contract_version: String,
    pub target: Target,
    pub session: Session,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConversionReport {
    pub mapped_turns: usize,
    pub degraded_blocks: usize,
    pub dropped_blocks: usize,
}

/// The report the archive produced, as it wrote it.
///
/// A bundle carries the server's own report — how many blocks it mapped, what
/// it degraded, what it dropped, whether it fell back to an injection prelude.
/// That was parsed into the struct above, whose fields have different names, so
/// the parse failed every time and `unwrap_or_default` printed zeros: a
/// conversion that dropped half a session reported nothing dropped. It is
/// carried through untouched now, because nothing here needs to interpret it
/// and inventing a shape for it is what hid the real one.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum MaterializedReport {
    /// Built here, when this machine converted a session itself.
    Local(ConversionReport),
    /// Written by the archive and passed on as-is.
    FromArchive(Value),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializationResult {
    pub target: Target,
    pub session_id: String,
    pub written: Vec<PathBuf>,
    pub unchanged: Vec<PathBuf>,
    pub resume_command: String,
    pub report: MaterializedReport,
}

#[derive(Debug)]
struct PlannedFile {
    path: PathBuf,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestBundle<'a> {
    contract_version: &'a str,
    bundle_version: &'a str,
    target: Target,
    session_id: &'a str,
    files: Vec<DigestFile<'a>>,
    resume_command: &'a str,
    report: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestFile<'a> {
    path: &'a str,
    media_type: &'a str,
    sha256: &'a str,
    size: u64,
}

fn verify_bundle_sha256(bundle: &ConversionBundle) -> Result<(), MaterializeError> {
    let actual = bundle_sha256(bundle)?;
    if actual != bundle.bundle_sha256 {
        return Err(MaterializeError::Integrity(format!(
            "bundle SHA-256 mismatch: expected {}, got {actual}",
            bundle.bundle_sha256
        )));
    }
    Ok(())
}

pub fn bundle_sha256(bundle: &ConversionBundle) -> Result<String, MaterializeError> {
    let mut files: Vec<_> = bundle
        .files
        .iter()
        .map(|file| DigestFile {
            path: &file.path,
            media_type: &file.media_type,
            sha256: &file.sha256,
            size: file.size,
        })
        .collect();
    files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    let digest_input = DigestBundle {
        contract_version: &bundle.contract_version,
        bundle_version: &bundle.bundle_version,
        target: bundle.target,
        session_id: &bundle.session_id,
        files,
        resume_command: &bundle.resume_command,
        report: canonical_json(&bundle.report),
    };
    Ok(content_sha256(&serde_json::to_vec(&digest_input)?))
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_json).collect()),
        Value::Object(values) => {
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort();
            let mut canonical = serde_json::Map::new();
            for key in keys {
                canonical.insert(key.clone(), canonical_json(&values[key]));
            }
            Value::Object(canonical)
        }
        other => other.clone(),
    }
}

pub fn content_sha256(bytes: &[u8]) -> String {
    // sha2 0.11 returns an Array that no longer implements LowerHex, so the
    // hex is written here rather than by the formatter. Lowercase and
    // zero-padded, because this digest is compared against the server's.
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn materialize_bundle(
    bundle: &ConversionBundle,
    home: &Path,
) -> Result<MaterializationResult, MaterializeError> {
    validate_contract_version(Some(&bundle.contract_version))?;
    if bundle.bundle_version != "1" {
        return Err(MaterializeError::Integrity(format!(
            "unsupported bundle version {}",
            bundle.bundle_version
        )));
    }
    verify_bundle_sha256(bundle)?;
    validate_session_id(&bundle.session_id)?;
    validate_home(home)?;
    if bundle.files.len() > 1024 {
        return Err(MaterializeError::Integrity(
            "bundle contains more than 1024 files".to_owned(),
        ));
    }
    let mut planned = Vec::with_capacity(bundle.files.len());
    let mut target_paths = HashSet::new();
    let mut total_bytes = 0_u64;
    for file in &bundle.files {
        if file.base64.len() > (MAX_BUNDLE_FILE_BYTES / 3 + 1) * 4 {
            return Err(MaterializeError::Decode {
                path: file.path.clone(),
                message: "encoded file exceeds allocation limit".to_owned(),
            });
        }
        let path = resolve_bundle_path(home, &file.path, bundle.target, &bundle.session_id)?;
        if !target_paths.insert(path.clone()) {
            return Err(MaterializeError::Integrity(format!(
                "duplicate target path {}",
                file.path
            )));
        }
        let decoded =
            BASE64
                .decode(file.base64.as_bytes())
                .map_err(|error| MaterializeError::Decode {
                    path: file.path.clone(),
                    message: error.to_string(),
                })?;
        if decoded.len() > MAX_BUNDLE_FILE_BYTES || decoded.len() as u64 != file.size {
            return Err(MaterializeError::Integrity(format!(
                "size mismatch for {}",
                file.path
            )));
        }
        total_bytes = total_bytes.saturating_add(file.size);
        if total_bytes > (MAX_BUNDLE_FILE_BYTES as u64) * 2 {
            return Err(MaterializeError::Integrity(
                "bundle exceeds total decoded byte limit".to_owned(),
            ));
        }
        if content_sha256(&decoded) != file.sha256 {
            return Err(MaterializeError::Integrity(format!(
                "SHA-256 mismatch for {}",
                file.path
            )));
        }
        if bundle.target == Target::AntigravityCli
            && path.extension().is_some_and(|extension| extension == "db")
        {
            validate_antigravity_database(&decoded, &bundle.session_id)?;
        }
        planned.push(PlannedFile {
            path,
            bytes: decoded,
        });
    }
    let (written, unchanged) = commit_plan(home, &planned)?;
    Ok(MaterializationResult {
        target: bundle.target,
        session_id: bundle.session_id.clone(),
        written,
        unchanged,
        resume_command: bundle.resume_command.clone(),
        report: MaterializedReport::FromArchive(bundle.report.clone()),
    })
}

pub fn materialize_canonical_bundle(
    bundle: &CanonicalConversionBundle,
    home: &Path,
) -> Result<MaterializationResult, MaterializeError> {
    if bundle.contract_version != memoar_canonical::CONTRACT_VERSION {
        return Err(MaterializeError::ContractVersion(
            bundle.contract_version.clone(),
        ));
    }
    materialize(&bundle.session, bundle.target, home)
}

pub fn materialize(
    session: &Session,
    target: Target,
    home: &Path,
) -> Result<MaterializationResult, MaterializeError> {
    validate_session_id(&session.id)?;
    validate_home(home)?;
    match target {
        Target::ClaudeCode => materialize_claude(session, home),
        Target::Codex => materialize_codex(session, home),
        Target::AntigravityCli => materialize_antigravity(session, home),
    }
}

fn materialize_claude(
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

fn materialize_codex(
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

fn materialize_antigravity(
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

fn antigravity_database_bytes(
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

fn validate_antigravity_database(bytes: &[u8], session_id: &str) -> Result<(), MaterializeError> {
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
fn validate_contract_version(version: Option<&str>) -> Result<(), MaterializeError> {
    if let Some(version) = version
        && version != memoar_canonical::CONTRACT_VERSION
    {
        return Err(MaterializeError::ContractVersion(version.to_owned()));
    }
    Ok(())
}

fn resolve_bundle_path(
    home: &Path,
    wire_path: &str,
    target: Target,
    session_id: &str,
) -> Result<PathBuf, MaterializeError> {
    let relative = wire_path
        .strip_prefix("~/")
        .ok_or_else(|| MaterializeError::UnsafePath(wire_path.to_owned()))?;
    let relative_path = Path::new(relative);
    if relative_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) | Component::CurDir
        )
    }) {
        return Err(MaterializeError::UnsafePath(wire_path.to_owned()));
    }
    let normalized = relative_path.to_string_lossy();
    let allowed_prefix = match target {
        Target::ClaudeCode => ".claude/projects/",
        Target::Codex => ".codex/sessions/",
        Target::AntigravityCli => ".gemini/antigravity-cli/brain/",
    };
    if !normalized.starts_with(allowed_prefix) || !normalized.contains(session_id) {
        return Err(MaterializeError::UnsafePath(wire_path.to_owned()));
    }
    Ok(home.join(relative_path))
}

fn validate_home(home: &Path) -> Result<(), MaterializeError> {
    if let Ok(metadata) = fs::symlink_metadata(home)
        && metadata.file_type().is_symlink()
    {
        return Err(MaterializeError::UnsafePath(home.display().to_string()));
    }
    Ok(())
}

fn commit_plan(
    home: &Path,
    planned: &[PlannedFile],
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), MaterializeError> {
    commit_plan_with_hook(home, planned, |_| Ok(()))
}

fn commit_plan_with_hook<F>(
    home: &Path,
    planned: &[PlannedFile],
    mut before_commit: F,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), MaterializeError>
where
    F: FnMut(usize) -> Result<(), std::io::Error>,
{
    let mut unchanged = Vec::new();
    for file in planned {
        verify_safe_ancestors(home, &file.path)?;
        match fs::symlink_metadata(&file.path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(MaterializeError::Collision(file.path.clone()));
            }
            Ok(_) => {
                let existing = fs::read(&file.path).map_err(|source| MaterializeError::Io {
                    path: file.path.clone(),
                    source,
                })?;
                if existing == file.bytes {
                    unchanged.push(file.path.clone());
                } else {
                    return Err(MaterializeError::Collision(file.path.clone()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(MaterializeError::Io {
                    path: file.path.clone(),
                    source,
                });
            }
        }
    }

    let mut staged = Vec::new();
    for file in planned {
        if unchanged.contains(&file.path) {
            continue;
        }
        create_safe_parent(home, &file.path)?;
        let parent = file
            .path
            .parent()
            .ok_or_else(|| MaterializeError::UnsafePath(file.path.display().to_string()))?;
        let temporary = parent.join(format!(".memoar-{}.tmp", Uuid::now_v7()));
        let stage_result = (|| -> Result<(), std::io::Error> {
            let mut handle = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            handle.write_all(&file.bytes)?;
            handle.sync_all()
        })();
        if let Err(source) = stage_result {
            let _ = fs::remove_file(&temporary);
            for (_, temporary) in &staged {
                let _ = fs::remove_file(temporary);
            }
            return Err(MaterializeError::Io {
                path: file.path.clone(),
                source,
            });
        }
        staged.push((file.path.clone(), temporary));
    }

    let mut written = Vec::new();
    for (index, (target, temporary)) in staged.iter().enumerate() {
        let result = before_commit(index).and_then(|()| fs::hard_link(temporary, target));
        if let Err(source) = result {
            for created in written.iter().rev() {
                let _ = fs::remove_file(created);
            }
            for (_, temporary) in &staged {
                let _ = fs::remove_file(temporary);
            }
            return Err(if source.kind() == std::io::ErrorKind::AlreadyExists {
                MaterializeError::Collision(target.clone())
            } else {
                MaterializeError::Io {
                    path: target.clone(),
                    source,
                }
            });
        }
        written.push(target.clone());
    }
    for (_, temporary) in &staged {
        let _ = fs::remove_file(temporary);
    }
    Ok((written, unchanged))
}

fn verify_safe_ancestors(home: &Path, path: &Path) -> Result<(), MaterializeError> {
    let relative = path
        .strip_prefix(home)
        .map_err(|_| MaterializeError::UnsafePath(path.display().to_string()))?;
    let mut current = home.to_path_buf();
    for component in relative
        .components()
        .take(relative.components().count().saturating_sub(1))
    {
        let Component::Normal(name) = component else {
            return Err(MaterializeError::UnsafePath(path.display().to_string()));
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(MaterializeError::UnsafePath(current.display().to_string()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(MaterializeError::Io {
                    path: current,
                    source,
                });
            }
        }
    }
    Ok(())
}

fn create_safe_parent(home: &Path, path: &Path) -> Result<(), MaterializeError> {
    let parent = path
        .parent()
        .ok_or_else(|| MaterializeError::UnsafePath(path.display().to_string()))?;
    let relative = parent
        .strip_prefix(home)
        .map_err(|_| MaterializeError::UnsafePath(path.display().to_string()))?;
    if !home.exists() {
        fs::create_dir(home).map_err(|source| MaterializeError::Io {
            path: home.to_path_buf(),
            source,
        })?;
    }
    let mut current = home.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(MaterializeError::UnsafePath(path.display().to_string()));
        };
        current.push(name);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata =
                    fs::symlink_metadata(&current).map_err(|source| MaterializeError::Io {
                        path: current.clone(),
                        source,
                    })?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(MaterializeError::UnsafePath(current.display().to_string()));
                }
            }
            Err(source) => {
                return Err(MaterializeError::Io {
                    path: current,
                    source,
                });
            }
        }
    }
    Ok(())
}

fn json_lines(records: &[Value]) -> Result<Vec<u8>, MaterializeError> {
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, record)?;
        bytes.push(b'\n');
    }
    Ok(bytes)
}

fn validate_session_id(id: &str) -> Result<(), MaterializeError> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(MaterializeError::InvalidSessionId(id.to_owned()));
    }
    Ok(())
}

fn encode_claude_workspace(workspace: &str) -> String {
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

fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn degraded_text(block: &ContentBlock) -> String {
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

fn report(session: &Session, degraded_blocks: usize) -> ConversionReport {
    ConversionReport {
        mapped_turns: session.turns.len(),
        degraded_blocks,
        dropped_blocks: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use memoar_canonical::{SourceDescriptor, TokenTotals, Turn, Visibility, WorkspaceDescriptor};

    fn fixture_session() -> Session {
        Session {
            id: "0198d8d0-977c-777b-9f8f-0f6d8416e701".to_owned(),
            source: SourceDescriptor {
                vendor: "anthropic".to_owned(),
                tool: "claude-code".to_owned(),
                version: "1".to_owned(),
                machine_id: "0198d8d0-977c-777b-9f8f-0f6d8416e702".to_owned(),
                native_session_id: None,
            },
            workspace: WorkspaceDescriptor {
                path: "/tmp/project".to_owned(),
                git_remote: None,
                branch: None,
            },
            created_at: "2026-08-17T10:00:00Z".to_owned(),
            updated_at: "2026-08-17T10:01:00Z".to_owned(),
            title: "Test".to_owned(),
            summary: None,
            models: vec!["model".to_owned()],
            token_totals: TokenTotals {
                input: 10,
                output: 5,
                cache_read: None,
                cache_write: None,
            },
            provenance: Vec::new(),
            visibility: Visibility {
                scope: "private".to_owned(),
                owner_id: "0198d8d0-977c-777b-9f8f-0f6d8416e703".to_owned(),
                team_id: None,
                org_id: None,
            },
            turns: vec![Turn {
                id: "0198d8d0-977c-777b-9f8f-0f6d8416e704".to_owned(),
                ordinal: 0,
                parent_id: None,
                role: "user".to_owned(),
                created_at: "2026-08-17T10:00:00Z".to_owned(),
                model: None,
                tokens: None,
                blocks: vec![ContentBlock {
                    id: "0198d8d0-977c-777b-9f8f-0f6d8416e705".to_owned(),
                    kind: ContentBlockKind::Text,
                    text: Some("hello".to_owned()),
                    name: None,
                    call_id: None,
                    language: None,
                    mime_type: None,
                    artifact_ref: None,
                    data: None,
                    ext: None,
                }],
                ext: None,
            }],
            ext: None,
        }
    }

    fn finalized_bundle(mut bundle: ConversionBundle) -> ConversionBundle {
        for file in &mut bundle.files {
            let bytes = BASE64.decode(file.base64.as_bytes()).unwrap();
            file.size = bytes.len() as u64;
            file.sha256 = content_sha256(&bytes);
        }
        bundle.bundle_sha256 = bundle_sha256(&bundle).unwrap();
        bundle
    }

    #[test]
    fn materializes_all_gated_targets_and_is_idempotent() {
        for target in [Target::ClaudeCode, Target::Codex, Target::AntigravityCli] {
            let temp = tempfile::tempdir().unwrap();
            let first = materialize(&fixture_session(), target, temp.path()).unwrap();
            assert!(!first.written.is_empty());
            assert!(first.written.iter().all(|path| path.exists()));
            let second = materialize(&fixture_session(), target, temp.path()).unwrap();
            assert!(second.written.is_empty());
            assert_eq!(second.unchanged.len(), first.written.len());
        }
    }

    #[test]
    fn server_native_bundle_decodes_and_materializes() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = fixture_session().id;
        let content = b"{\"type\":\"message\"}\n";
        let bundle = finalized_bundle(ConversionBundle {
            contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
            bundle_version: "1".to_owned(),
            bundle_sha256: String::new(),
            target: Target::ClaudeCode,
            session_id: session_id.clone(),
            files: vec![BundleFile {
                path: format!("~/.claude/projects/-tmp-project/{session_id}.jsonl"),
                media_type: "application/x-ndjson".to_owned(),
                base64: BASE64.encode(content),
                sha256: String::new(),
                size: 0,
            }],
            resume_command: format!("claude -r {session_id}"),
            report: json!({"mappedTurns": 1, "degradedBlocks": 0, "droppedBlocks": 0}),
        });
        let result = materialize_bundle(&bundle, temp.path()).unwrap();
        assert_eq!(fs::read(&result.written[0]).unwrap(), content);
    }

    #[test]
    fn a_bundle_reports_what_the_archive_said_it_did() {
        // The archive writes {"mapped":N,"degraded":[...],"dropped":[...],
        // "fallback":bool}. That was parsed into this crate's own report
        // struct, whose fields are named differently, so the parse failed every
        // time and unwrap_or_default printed zeros: a conversion that dropped
        // half a session reported nothing dropped, and the fixture beside it
        // used this crate's names, so nothing caught it.
        let temp = tempfile::tempdir().unwrap();
        let session_id = fixture_session().id;
        let archive_report = json!({
            "mapped": 4,
            "degraded": [{"turnId": "t1", "blockId": "b1", "kind": "image", "reason": "no native representation"}],
            "dropped": [{"reference": "turns:5-900", "reason": "injection_token_budget_exceeded"}],
            "fallback": true,
        });
        let bundle = finalized_bundle(ConversionBundle {
            contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
            bundle_version: "1".to_owned(),
            bundle_sha256: String::new(),
            target: Target::ClaudeCode,
            session_id: session_id.clone(),
            files: vec![BundleFile {
                path: format!("~/.claude/projects/-tmp-project/{session_id}.jsonl"),
                media_type: "application/x-ndjson".to_owned(),
                base64: BASE64.encode(b"{\"type\":\"message\"}\n"),
                sha256: String::new(),
                size: 0,
            }],
            resume_command: format!("claude -r {session_id}"),
            report: archive_report.clone(),
        });

        let result = materialize_bundle(&bundle, temp.path()).unwrap();

        let reported = serde_json::to_value(&result.report).unwrap();
        assert_eq!(
            reported, archive_report,
            "the archive's report must survive the trip"
        );
        assert_eq!(reported["dropped"].as_array().unwrap().len(), 1);
        assert_eq!(reported["fallback"], json!(true));
    }

    #[test]
    fn antigravity_bundle_builds_observed_sqlite_schema() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = fixture_session().id;
        let seed = serde_json::to_vec(
            &json!({"id": session_id, "workspacePath": "/tmp/project", "title": "Test"}),
        )
        .unwrap();
        let native_database = antigravity_database_bytes(&session_id, &seed).unwrap();
        let bundle = finalized_bundle(ConversionBundle {
            contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
            bundle_version: "1".to_owned(),
            bundle_sha256: String::new(),
            target: Target::AntigravityCli,
            session_id: session_id.clone(),
            files: vec![BundleFile {
                path: format!(
                    "~/.gemini/antigravity-cli/brain/{session_id}/conversations/{session_id}.db"
                ),
                media_type: "application/vnd.sqlite3".to_owned(),
                base64: BASE64.encode(&native_database),
                sha256: String::new(),
                size: 0,
            }],
            resume_command: format!("agy --conversation {session_id}"),
            report: json!({}),
        });
        let result = materialize_bundle(&bundle, temp.path()).unwrap();
        assert_eq!(fs::read(&result.written[0]).unwrap(), native_database);
        let database = Connection::open(&result.written[0]).unwrap();
        let integrity: String = database
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        let version: i64 = database
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let trajectory: String = database
            .query_row("SELECT trajectory_id FROM trajectory_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(integrity, "ok");
        assert_eq!(version, 1);
        assert_eq!(trajectory, session_id);
    }

    #[test]
    fn keeps_a_materialized_session_inside_the_projects_directory() {
        // workspace.path arrives from the server and is only encoded, never
        // validated. The encoder folds separators to '-' so the result is a
        // single component, but it preserves '.', so the components that
        // actually traverse have to be refused rather than encoded away.
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join(".claude/projects");
        let mut wrote_something = false;

        for hostile in [".", "../..", "..\\..", "....", "~", "/etc", "..;/"] {
            let mut session = fixture_session();
            session.workspace.path = hostile.to_owned();
            let Ok(result) = materialize(&session, Target::ClaudeCode, temp.path()) else {
                continue;
            };
            for written in &result.written {
                wrote_something = true;
                let resolved = written.canonicalize().expect("a written file must resolve");
                let root = projects
                    .canonicalize()
                    .expect("projects directory must exist once written");
                assert!(
                    resolved.starts_with(&root),
                    "workspace {hostile:?} escaped the projects directory: {}",
                    resolved.display()
                );
            }
        }

        // Without this the loop could pass by refusing every input, which would
        // prove the guard is strict rather than that it is correct.
        assert!(
            wrote_something,
            "no workspace was accepted, so nothing was actually checked"
        );
    }

    #[test]
    fn refuses_a_workspace_that_would_climb_out_of_the_projects_directory() {
        // ".." survives the encoder intact — it contains no separator and only
        // characters the encoder keeps — so it must be caught when the path is
        // written rather than when it is encoded.
        let temp = tempfile::tempdir().unwrap();
        let mut session = fixture_session();
        session.workspace.path = "..".to_owned();
        let error = materialize(&session, Target::ClaudeCode, temp.path())
            .expect_err("a workspace of '..' must not be materialized");
        assert!(
            matches!(error, MaterializeError::UnsafePath(_)),
            "expected an unsafe-path refusal, got: {error}"
        );
        assert!(
            !temp
                .path()
                .join(".claude")
                .join(format!("{}.jsonl", session.id))
                .exists(),
            "the refusal must happen before anything is written"
        );
    }

    #[test]
    fn refuses_collision_before_writing_any_bundle_file() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = fixture_session().id;
        let first = temp
            .path()
            .join(format!(".claude/projects/-tmp/{session_id}.jsonl"));
        fs::create_dir_all(first.parent().unwrap()).unwrap();
        fs::write(&first, "existing").unwrap();
        let second = format!("~/.claude/projects/-tmp/{session_id}-other.jsonl");
        let bundle = finalized_bundle(ConversionBundle {
            contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
            bundle_version: "1".to_owned(),
            bundle_sha256: String::new(),
            target: Target::ClaudeCode,
            session_id: session_id.clone(),
            files: vec![
                BundleFile {
                    path: format!("~/.claude/projects/-tmp/{session_id}.jsonl"),
                    media_type: "application/x-ndjson".to_owned(),
                    base64: BASE64.encode("different"),
                    sha256: String::new(),
                    size: 0,
                },
                BundleFile {
                    path: second.clone(),
                    media_type: "application/x-ndjson".to_owned(),
                    base64: BASE64.encode("new"),
                    sha256: String::new(),
                    size: 0,
                },
            ],
            resume_command: String::new(),
            report: json!({}),
        });
        assert!(matches!(
            materialize_bundle(&bundle, temp.path()),
            Err(MaterializeError::Collision(_))
        ));
        assert!(
            !resolve_bundle_path(temp.path(), &second, Target::ClaudeCode, &session_id)
                .unwrap()
                .exists()
        );
    }

    #[test]
    fn multi_file_commit_rolls_back_each_injected_failure_point() {
        for fail_at in 0..3 {
            let temp = tempfile::tempdir().unwrap();
            let planned: Vec<_> = (0..3)
                .map(|index| PlannedFile {
                    path: temp.path().join(format!("native/session-{index}.jsonl")),
                    bytes: format!("record-{index}").into_bytes(),
                })
                .collect();
            let result = commit_plan_with_hook(temp.path(), &planned, |index| {
                if index == fail_at {
                    Err(std::io::Error::other("injected commit failure"))
                } else {
                    Ok(())
                }
            });
            assert!(result.is_err());
            assert!(planned.iter().all(|file| !file.path.exists()));
        }
    }

    #[test]
    fn refuses_path_traversal_session_ids_and_bundle_paths() {
        let mut session = fixture_session();
        session.id = "../../outside".to_owned();
        let temp = tempfile::tempdir().unwrap();
        assert!(matches!(
            materialize(&session, Target::Codex, temp.path()),
            Err(MaterializeError::InvalidSessionId(_))
        ));
        assert!(
            resolve_bundle_path(
                temp.path(),
                "~/.codex/sessions/../../escape.jsonl",
                Target::Codex,
                "safe-id"
            )
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_ancestor() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), temp.path().join(".claude")).unwrap();
        assert!(matches!(
            materialize(&fixture_session(), Target::ClaudeCode, temp.path()),
            Err(MaterializeError::UnsafePath(_))
        ));
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }
}
