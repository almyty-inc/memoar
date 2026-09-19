//! Taking a file into the queue as an immutable content-addressed snapshot.

use chrono::{DateTime, Utc};
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::SystemTime;
use uuid::Uuid;

use crate::artifact::redact_artifact;
use crate::error::DaemonError;
use crate::queue::{OfflineQueue, QueuedArtifact};
use crate::redaction::RedactionConfig;
use crate::transport::MAX_ARTIFACT_BYTES;

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
        // Stat first, and refuse the file before reading a byte of it.
        //
        // `MAX_ARTIFACT_BYTES` was declared and never consulted: this read the
        // whole file into memory, hashed it, wrote a second copy of it into the
        // blob directory and queued it for a server that answers 413. A 500 MB
        // stray file cost half a gigabyte of resident memory and half a
        // gigabyte of disk to learn something `metadata` already knew.
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
        let source_bytes = fs::read(path).map_err(|source| DaemonError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let transformed = redact_artifact(path, &source_bytes, redaction)?;
        let sha256 = sha256_bytes(&transformed.bytes);
        let blob_path = self.blob_dir.join(&sha256);
        write_blob_once(&blob_path, &transformed.bytes)?;
        let modified_at: DateTime<Utc> = metadata.modified().unwrap_or(SystemTime::now()).into();
        let source_path = path.to_string_lossy().into_owned();
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO artifacts
               (sha256, source_path, size, source, local_path, modified_at, status, queued_at,
                redacted, redaction_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9)
             ON CONFLICT(sha256, source_path) DO UPDATE SET
               size = excluded.size,
               source = excluded.source,
               local_path = excluded.local_path,
               modified_at = excluded.modified_at,
               status = CASE WHEN artifacts.status = 'synced' THEN 'synced' ELSE 'pending' END,
               last_error = NULL,
               redacted = excluded.redacted,
               redaction_count = excluded.redaction_count",
            params![
                sha256,
                source_path,
                transformed.bytes.len() as i64,
                source,
                blob_path.to_string_lossy(),
                modified_at.to_rfc3339(),
                now,
                transformed.replacements > 0,
                transformed.replacements,
            ],
        )?;
        self.get(&sha256, &source_path)?.ok_or_else(|| {
            DaemonError::Protocol("queued artifact disappeared after insert".to_owned())
        })
    }
}

fn write_blob_once(path: &Path, bytes: &[u8]) -> Result<(), DaemonError> {
    if path.exists() {
        let existing = fs::read(path).map_err(|source| DaemonError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if existing == bytes {
            return Ok(());
        }
        return Err(DaemonError::Protocol(format!(
            "content-addressed blob collision at {}",
            path.display()
        )));
    }
    let temp = path.with_extension(format!("tmp-{}", Uuid::now_v7()));
    let result = (|| -> Result<(), DaemonError> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|source| DaemonError::Io {
                path: temp.clone(),
                source,
            })?;
        file.write_all(bytes).map_err(|source| DaemonError::Io {
            path: temp.clone(),
            source,
        })?;
        file.sync_all().map_err(|source| DaemonError::Io {
            path: temp.clone(),
            source,
        })?;
        fs::rename(&temp, path).map_err(|source| DaemonError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[must_use]
pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
