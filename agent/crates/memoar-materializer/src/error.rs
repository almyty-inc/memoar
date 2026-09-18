//! The failure modes of materializing a bundle onto this machine.

use std::path::PathBuf;
use thiserror::Error;

pub(crate) const MAX_BUNDLE_FILE_BYTES: usize = 512 * 1024 * 1024;

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
    #[error("a project memory conversion needs the workspace its files belong to")]
    MissingWorkspace,
}
