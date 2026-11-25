//! Taking a file into the queue: its hash and where it is, not a copy of it.
//!
//! Every artifact used to be written into the blob directory at capture, so
//! a first sync of 58 GB of sessions needed 58 GB more before it uploaded
//! anything, and filled the disk at 36 GB. A row now names the source file
//! and its hash, and the upload reads the source and checks the hash. A
//! private copy is still kept where the source cannot stand in for the bytes:
//! content redaction changed, and databases the tools rewrite in place.

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::fs::{self, Metadata};
use std::path::Path;
use std::time::SystemTime;

use crate::artifact::redact_artifact;
use crate::blobs::write_blob_once;
use crate::error::DaemonError;
use crate::queue::{OfflineQueue, QueueStatus, QueuedArtifact};
use crate::redaction::RedactionConfig;
use crate::transport::MAX_ARTIFACT_BYTES;
use crate::workspace::WorkspaceResolver;

impl OfflineQueue {
    pub fn enqueue(&self, source: &str, path: &Path) -> Result<QueuedArtifact, DaemonError> {
        self.enqueue_with_redaction(source, path, RedactionConfig::disabled())
    }

    pub fn enqueue_with_redaction(
        &self,
        source: &str,
        path: &Path,
        redaction: RedactionConfig,
    ) -> Result<QueuedArtifact, DaemonError> {
        let metadata = stat_within_limit(path)?;
        let bytes = read_source(path)?;
        let workspace = WorkspaceResolver::new().resolve(source, path, Some(&bytes));
        self.enqueue_bytes(
            source,
            path,
            &metadata,
            &bytes,
            redaction,
            workspace.as_deref(),
        )
    }

    /// Queues a file whose bytes the caller has already read.
    pub(crate) fn enqueue_bytes(
        &self,
        source: &str,
        path: &Path,
        metadata: &Metadata,
        source_bytes: &[u8],
        redaction: RedactionConfig,
        workspace: Option<&str>,
    ) -> Result<QueuedArtifact, DaemonError> {
        let transformed = redact_artifact(path, source_bytes, redaction)?;
        let sha256 = sha256_bytes(&transformed.bytes);
        let source_path = path.to_string_lossy().into_owned();
        let synced = self.status_of(&sha256, &source_path)? == Some(QueueStatus::Synced);
        // The source stands in for the upload when it holds exactly the bytes
        // to send and will still hold them later. Nothing is kept for a row
        // the archive already has.
        let needs_copy = transformed.replacements > 0 || must_snapshot(path);
        let local_path = if needs_copy && !synced {
            let blob = self.blob_dir.join(&sha256);
            self.ensure_space(transformed.bytes.len() as u64)?;
            write_blob_once(&blob, &transformed.bytes)?;
            blob.to_string_lossy().into_owned()
        } else {
            String::new()
        };
        self.connection.execute(
            "INSERT INTO artifacts
               (sha256, source_path, size, source, local_path, modified_at, status, queued_at,
                redacted, redaction_count, source_size, redaction_key, workspace)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(sha256, source_path) DO UPDATE SET
               size = excluded.size,
               source = excluded.source,
               local_path = excluded.local_path,
               modified_at = excluded.modified_at,
               status = CASE WHEN artifacts.status = 'synced' THEN 'synced' ELSE 'pending' END,
               last_error = NULL,
               redacted = excluded.redacted,
               redaction_count = excluded.redaction_count,
               source_size = excluded.source_size,
               redaction_key = excluded.redaction_key,
               workspace = excluded.workspace",
            params![
                sha256,
                source_path,
                transformed.bytes.len() as i64,
                source,
                local_path,
                modified_at(metadata),
                Utc::now().to_rfc3339(),
                transformed.replacements > 0,
                transformed.replacements,
                metadata.len() as i64,
                redaction_key(redaction),
                workspace,
            ],
        )?;
        self.get(&sha256, &source_path)?.ok_or_else(|| {
            DaemonError::Protocol("queued artifact disappeared after insert".to_owned())
        })
    }

    /// Whether this file, at this size and modification time, was already
    /// queued under the same redaction settings. Answered from a `stat`, so an
    /// unchanged store is not read and hashed again on every sync.
    pub(crate) fn already_queued(
        &self,
        path: &Path,
        metadata: &Metadata,
        redaction: RedactionConfig,
    ) -> Result<bool, DaemonError> {
        let found: Option<i64> = self
            .connection
            .query_row(
                "SELECT 1 FROM artifacts
                 WHERE source_path = ?1 AND modified_at = ?2 AND source_size = ?3
                   AND redaction_key = ?4
                 LIMIT 1",
                params![
                    path.to_string_lossy(),
                    modified_at(metadata),
                    metadata.len() as i64,
                    redaction_key(redaction)
                ],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    fn status_of(
        &self,
        sha256: &str,
        source_path: &str,
    ) -> Result<Option<QueueStatus>, DaemonError> {
        let status: Option<String> = self
            .connection
            .query_row(
                "SELECT status FROM artifacts WHERE sha256 = ?1 AND source_path = ?2",
                params![sha256, source_path],
                |row| row.get(0),
            )
            .optional()?;
        Ok(status.as_deref().map(QueueStatus::parse))
    }
}

/// Stat first, and refuse the file before reading a byte of it.
///
/// `MAX_ARTIFACT_BYTES` was declared and never consulted: a 500 MB stray file
/// cost half a gigabyte of memory and of disk to learn what `metadata` knew.
pub(crate) fn stat_within_limit(path: &Path) -> Result<Metadata, DaemonError> {
    let metadata = fs::metadata(path).map_err(|source| DaemonError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.len() > MAX_ARTIFACT_BYTES {
        return Err(DaemonError::TooLarge {
            path: path.to_path_buf(),
            size: metadata.len(),
            limit: MAX_ARTIFACT_BYTES,
        });
    }
    Ok(metadata)
}

pub(crate) fn read_source(path: &Path) -> Result<Vec<u8>, DaemonError> {
    fs::read(path).map_err(|source| DaemonError::Io {
        path: path.to_path_buf(),
        source,
    })
}

/// A source file's modification time as the queue records it.
pub(crate) fn modified_at(metadata: &Metadata) -> String {
    modified_instant(metadata).to_rfc3339()
}

pub(crate) fn modified_instant(metadata: &Metadata) -> DateTime<Utc> {
    metadata.modified().unwrap_or(SystemTime::now()).into()
}

/// The redaction settings a row was captured under, so turning a mask on
/// makes every file pending upload be read again rather than sent as it was.
pub(crate) fn redaction_key(redaction: RedactionConfig) -> String {
    format!(
        "s{}e{}h{}",
        u8::from(redaction.secrets),
        u8::from(redaction.email_addresses),
        u8::from(redaction.home_paths)
    )
}

/// Stores the tools rewrite in place while they run: SQLite databases and
/// their journals. Reading one back at upload would find different bytes
/// almost every time, so the bytes hashed at capture are kept.
pub(crate) fn must_snapshot(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    [
        ".db", ".sqlite", ".sqlite3", ".vscdb", "-wal", "-shm", "-journal",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix))
}

#[must_use]
pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
