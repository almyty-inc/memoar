// Generated from contracts/source/canonical.model.json. Do not edit.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONTRACT_VERSION: &str = "0.2.0";

pub type Uuid = String;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDescriptor {
    pub vendor: String,
    pub tool: String,
    pub version: String,
    pub machine_id: Uuid,
    pub native_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDescriptor {
    pub path: String,
    pub git_remote: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceEntry {
    pub kind: String,
    pub source_id: Option<String>,
    pub captured_at: String,
    pub parser_version: Option<String>,
    pub details: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Visibility {
    pub scope: String,
    pub owner_id: Uuid,
    pub team_id: Option<Uuid>,
    pub org_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentBlockKind {
    Text,
    Thinking,
    ToolCall,
    ToolResult,
    Diff,
    Artifact,
    Attachment,
    System,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlock {
    pub id: Uuid,
    pub kind: ContentBlockKind,
    pub text: Option<String>,
    pub name: Option<String>,
    pub call_id: Option<String>,
    pub language: Option<String>,
    pub mime_type: Option<String>,
    pub artifact_ref: Option<String>,
    pub data: Option<BTreeMap<String, serde_json::Value>>,
    pub ext: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: Uuid,
    pub ordinal: u64,
    pub parent_id: Option<Uuid>,
    pub role: String,
    pub created_at: String,
    pub model: Option<String>,
    pub tokens: Option<TokenTotals>,
    pub blocks: Vec<ContentBlock>,
    pub ext: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationKind {
    Tag,
    Collection,
    Pin,
    Note,
    Summary,
    RedactionMask,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: Uuid,
    pub session_id: Uuid,
    pub turn_id: Option<Uuid>,
    pub block_id: Option<Uuid>,
    pub kind: AnnotationKind,
    pub value: BTreeMap<String, serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawArtifact {
    pub id: Uuid,
    pub session_ids: Option<Vec<Uuid>>,
    pub sha256: String,
    pub size: u64,
    pub object_key: String,
    pub status: String,
    pub source_path: Option<String>,
    pub captured_at: String,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: Uuid,
    pub source: SourceDescriptor,
    pub workspace: WorkspaceDescriptor,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    pub summary: Option<String>,
    pub models: Vec<String>,
    pub token_totals: TokenTotals,
    pub provenance: Vec<ProvenanceEntry>,
    pub visibility: Visibility,
    pub turns: Vec<Turn>,
    pub ext: Option<BTreeMap<String, serde_json::Value>>,
}

