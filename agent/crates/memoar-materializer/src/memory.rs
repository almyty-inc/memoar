//! Writing a ported memory file onto this machine, and where it may land.
//!
//! # What plays the session id's role
//!
//! `resolve_bundle_path` pins a per-target prefix and then requires the session
//! id to appear in the path. It needs that second token because the prefix is
//! broad: `~/.claude/projects/<anything>/<anything>.jsonl` is a large space, and
//! without the id an archive could aim one job's bundle at another session's
//! file.
//!
//! A memory file has no session id, and it cannot have one: the whole point is
//! to land at the exact path the target tool reads, which is `~/.codex/AGENTS.md`
//! and nothing else. What replaces the id is the destination itself. The bundle
//! declares a dialect and a scope; this module looks the pair up in its own copy
//! of the table and requires the wire path to be the literal it finds, byte for
//! byte. The allowed set is finite, fixed at compile time, and never read from
//! the bundle — so the containment is strictly tighter than the session case,
//! not looser. A rules directory is the one place a name is not a literal, and
//! there the fixed prefix is followed by exactly one component drawn from
//! `[a-z0-9][a-z0-9-]*\.md`: no separator, no dot segment, no second extension.
//!
//! The root is chosen the same way: the home directory for a global conversion,
//! and for a project one the workspace the caller named on the command line —
//! never a path out of the bundle, because that is the archive choosing where
//! to write on somebody's disk.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use crate::bundle::{PlannedFile, content_sha256};
use crate::commit::commit_plan;
use crate::error::MaterializeError;
use crate::memory_dialects::{MemoryDestination, MemoryDialect, memory_destination, root_prefix};
use crate::validate::{validate_contract_version, validate_home};
use memoar_canonical::MemoryScope;

/// These are files somebody typed by hand. A megabyte each is already far
/// beyond any of them, and the archive refuses a capture above that.
const MAX_MEMORY_FILE_BYTES: usize = 1024 * 1024;
const MAX_MEMORY_FILES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBundleFile {
    pub path: String,
    pub media_type: String,
    pub base64: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConversionReport {
    pub documents: u64,
    pub concatenated: bool,
}

/// The server's `POST /memory/conversions` response, as it is written.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConversionBundle {
    pub contract_version: String,
    pub bundle_version: String,
    pub kind: String,
    pub source: String,
    pub target: MemoryDialect,
    pub scope: MemoryScope,
    #[serde(default)]
    pub workspace_path: Option<String>,
    pub files: Vec<MemoryBundleFile>,
    pub report: MemoryConversionReport,
    pub bundle_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMaterializationResult {
    pub target: MemoryDialect,
    pub scope: MemoryScope,
    pub written: Vec<PathBuf>,
    pub unchanged: Vec<PathBuf>,
    pub report: MemoryConversionReport,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestFile<'a> {
    path: &'a str,
    media_type: &'a str,
    sha256: &'a str,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestBundle<'a> {
    contract_version: &'a str,
    bundle_version: &'a str,
    kind: &'a str,
    source: &'a str,
    target: MemoryDialect,
    scope: &'a MemoryScope,
    workspace_path: Option<&'a str>,
    files: Vec<DigestFile<'a>>,
    report: &'a MemoryConversionReport,
}

/// The same manifest the archive digested, in the same field order.
pub fn memory_bundle_sha256(bundle: &MemoryConversionBundle) -> Result<String, MaterializeError> {
    let digest_input = DigestBundle {
        contract_version: &bundle.contract_version,
        bundle_version: &bundle.bundle_version,
        kind: &bundle.kind,
        source: &bundle.source,
        target: bundle.target,
        scope: &bundle.scope,
        workspace_path: bundle.workspace_path.as_deref(),
        files: bundle
            .files
            .iter()
            .map(|file| DigestFile {
                path: &file.path,
                media_type: &file.media_type,
                sha256: &file.sha256,
                size: file.size,
            })
            .collect(),
        report: &bundle.report,
    };
    Ok(content_sha256(&serde_json::to_vec(&digest_input)?))
}

/// A name a conversion is allowed to give a file inside a rules directory.
fn is_rules_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".md") else {
        return false;
    };
    stem.starts_with(|first: char| first.is_ascii_lowercase() || first.is_ascii_digit())
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(crate) fn resolve_memory_path(
    root: &Path,
    wire_path: &str,
    dialect: MemoryDialect,
    scope: &MemoryScope,
) -> Result<PathBuf, MaterializeError> {
    let relative = wire_path
        .strip_prefix(root_prefix(scope))
        .ok_or_else(|| MaterializeError::UnsafePath(wire_path.to_owned()))?;
    if relative.contains('\\') {
        return Err(MaterializeError::UnsafePath(wire_path.to_owned()));
    }
    let relative_path = Path::new(relative);
    if relative_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(MaterializeError::UnsafePath(wire_path.to_owned()));
    }
    let destination = memory_destination(dialect, scope)
        .ok_or_else(|| MaterializeError::UnsafePath(wire_path.to_owned()))?;
    let allowed = match destination {
        // The whole path is the literal the table holds. Nothing from the
        // bundle contributes to it.
        MemoryDestination::File(path) => relative == path,
        MemoryDestination::Directory(directory) => relative
            .strip_prefix(directory)
            .and_then(|rest| rest.strip_prefix('/'))
            .is_some_and(|name| !name.contains('/') && is_rules_file_name(name)),
    };
    if !allowed {
        return Err(MaterializeError::UnsafePath(wire_path.to_owned()));
    }
    Ok(root.join(relative_path))
}

/// Writes a ported memory bundle, refusing to overwrite anybody's own file.
///
/// `workspace` is required for a project conversion and ignored for a global
/// one. Collisions are the materializer's existing rule: bytes that already
/// match are left alone and counted as unchanged, and bytes that differ stop
/// the whole commit rather than replacing an `AGENTS.md` somebody wrote.
pub fn materialize_memory_bundle(
    bundle: &MemoryConversionBundle,
    home: &Path,
    workspace: Option<&Path>,
) -> Result<MemoryMaterializationResult, MaterializeError> {
    validate_contract_version(Some(&bundle.contract_version))?;
    if bundle.bundle_version != "1" || bundle.kind != "memory" {
        return Err(MaterializeError::Integrity(format!(
            "unsupported memory bundle {} / {}",
            bundle.bundle_version, bundle.kind
        )));
    }
    let expected = memory_bundle_sha256(bundle)?;
    if expected != bundle.bundle_sha256 {
        return Err(MaterializeError::Integrity(format!(
            "bundle SHA-256 mismatch: expected {}, got {expected}",
            bundle.bundle_sha256
        )));
    }
    if bundle.files.len() > MAX_MEMORY_FILES {
        return Err(MaterializeError::Integrity(
            "memory bundle contains too many files".to_owned(),
        ));
    }
    let root = match bundle.scope {
        MemoryScope::Global => home,
        MemoryScope::Project => workspace.ok_or(MaterializeError::MissingWorkspace)?,
    };
    validate_home(root)?;
    let mut planned = Vec::with_capacity(bundle.files.len());
    let mut seen = HashSet::new();
    for file in &bundle.files {
        if file.base64.len() > (MAX_MEMORY_FILE_BYTES / 3 + 1) * 4 {
            return Err(MaterializeError::Decode {
                path: file.path.clone(),
                message: "encoded file exceeds allocation limit".to_owned(),
            });
        }
        let path = resolve_memory_path(root, &file.path, bundle.target, &bundle.scope)?;
        if !seen.insert(path.clone()) {
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
        if decoded.len() > MAX_MEMORY_FILE_BYTES || decoded.len() as u64 != file.size {
            return Err(MaterializeError::Integrity(format!(
                "size mismatch for {}",
                file.path
            )));
        }
        if content_sha256(&decoded) != file.sha256 {
            return Err(MaterializeError::Integrity(format!(
                "SHA-256 mismatch for {}",
                file.path
            )));
        }
        planned.push(PlannedFile {
            path,
            bytes: decoded,
        });
    }
    let (written, unchanged) = commit_plan(root, &planned)?;
    Ok(MemoryMaterializationResult {
        target: bundle.target,
        scope: bundle.scope.clone(),
        written,
        unchanged,
        report: bundle.report.clone(),
    })
}

/// The bundle as the CLI received it, for an operator who wants to look before
/// anything is written.
#[must_use]
pub fn memory_bundle_preview(bundle: &MemoryConversionBundle) -> Value {
    serde_json::json!({
        "source": bundle.source,
        "target": bundle.target.as_str(),
        "files": bundle.files.iter().map(|file| {
            serde_json::json!({ "path": file.path, "size": file.size, "sources": file.sources })
        }).collect::<Vec<_>>(),
    })
}
