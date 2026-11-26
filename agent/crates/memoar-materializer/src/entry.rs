//! The entry point: writing the bundle the archive built.
//!
//! The archive's writers (`server/src/convert/*-writer.ts`) are the only
//! writers of the native formats. This crate used to carry a second set, in
//! Rust, that nothing outside its own tests called. The two disagreed on the
//! shape of every target, and the one the CLI actually used was the one
//! without tests against the real tools. A bundle is written here exactly as
//! the archive built it, after its digests are checked.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use std::collections::HashSet;
use std::path::Path;

use crate::antigravity::validate_antigravity_database;
use crate::bundle::{
    ConversionBundle, MaterializationResult, PlannedFile, content_sha256, verify_bundle_sha256,
};
use crate::commit::commit_plan;
use crate::error::{MAX_BUNDLE_FILE_BYTES, MaterializeError};
use crate::paths::resolve_bundle_path;
use crate::target::Target;
use crate::validate::{validate_contract_version, validate_home, validate_session_id};

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
        report: bundle.report.clone(),
    })
}
