//! The download wire format, its digest, and the plan a commit works from.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

use crate::error::MaterializeError;
use crate::target::Target;
use memoar_canonical::Session;

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
pub(crate) struct PlannedFile {
    pub(crate) path: PathBuf,
    pub(crate) bytes: Vec<u8>,
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

pub(crate) fn verify_bundle_sha256(bundle: &ConversionBundle) -> Result<(), MaterializeError> {
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
