//! The cheap refusals: contract version, session id, and the home itself.

use std::fs;
use std::path::Path;

use crate::error::MaterializeError;

pub(crate) fn validate_contract_version(version: Option<&str>) -> Result<(), MaterializeError> {
    if let Some(version) = version
        && version != memoar_canonical::CONTRACT_VERSION
    {
        return Err(MaterializeError::ContractVersion(version.to_owned()));
    }
    Ok(())
}

pub(crate) fn validate_home(home: &Path) -> Result<(), MaterializeError> {
    if let Ok(metadata) = fs::symlink_metadata(home)
        && metadata.file_type().is_symlink()
    {
        return Err(MaterializeError::UnsafePath(home.display().to_string()));
    }
    Ok(())
}

pub(crate) fn validate_session_id(id: &str) -> Result<(), MaterializeError> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(MaterializeError::InvalidSessionId(id.to_owned()));
    }
    Ok(())
}
