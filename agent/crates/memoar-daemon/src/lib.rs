//! Local capture, immutable offline queueing, optional redaction, and delta sync.

use chrono::{DateTime, Utc};
use memoar_connectors::{OperatingSystem, SOURCES, files_for_source};
use regex::Regex;
use reqwest::blocking::Client;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use thiserror::Error;
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Error)]
pub enum DaemonError {
    #[error("queue database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("artifact I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("source discovery failed: {0}")]
    Discovery(#[from] memoar_connectors::DiscoveryError),
    #[error("sync transport failed: {0}")]
    Transport(String),
    #[error("server returned an invalid response: {0}")]
    Protocol(String),
    #[error("client redaction is unsupported for opaque artifact {0}")]
    UnsupportedRedaction(PathBuf),
    #[error("ZIP redaction failed for {path}: {message}")]
    Zip { path: PathBuf, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueStatus {
    Pending,
    Retry,
    Synced,
}

impl QueueStatus {
    fn parse(value: &str) -> Self {
        match value {
            "synced" => Self::Synced,
            "retry" => Self::Retry,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedArtifact {
    pub sha256: String,
    pub size: u64,
    pub source: String,
    pub source_path: String,
    /// Immutable content-addressed snapshot. Sync never re-reads the mutable source file.
    pub local_path: PathBuf,
    pub modified_at: String,
    pub status: QueueStatus,
    pub attempts: u32,
    pub last_error: Option<String>,
    pub redacted: bool,
    pub redaction_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCounts {
    pub pending: u64,
    pub retry: u64,
    pub synced: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionConfig {
    pub secrets: bool,
    pub email_addresses: bool,
    pub home_paths: bool,
}

impl RedactionConfig {
    #[must_use]
    pub const fn disabled() -> Self {
        Self {
            secrets: false,
            email_addresses: false,
            home_paths: false,
        }
    }

    #[must_use]
    pub const fn enabled(self) -> bool {
        self.secrets || self.email_addresses || self.home_paths
    }
}

#[derive(Debug, Clone)]
struct RedactedBytes {
    bytes: Vec<u8>,
    replacements: u32,
}

fn redact_bytes(bytes: &[u8], config: RedactionConfig) -> RedactedBytes {
    if !config.enabled() {
        return RedactedBytes {
            bytes: bytes.to_vec(),
            replacements: 0,
        };
    }
    let Ok(mut text) = String::from_utf8(bytes.to_vec()) else {
        return RedactedBytes {
            bytes: bytes.to_vec(),
            replacements: 0,
        };
    };
    let mut replacements = 0_u32;
    let mut apply = |pattern: &str, replacement: &str| {
        let regex = Regex::new(pattern).expect("static redaction pattern must compile");
        let matches = regex.find_iter(&text).count() as u32;
        if matches > 0 {
            text = regex.replace_all(&text, replacement).into_owned();
            replacements = replacements.saturating_add(matches);
        }
    };
    if config.secrets {
        apply(
            r"(?is)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
            "[REDACTED_PRIVATE_KEY]",
        );
        apply(
            r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
            "[REDACTED_JWT]",
        );
        apply(
            r#"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b([ \t]*[:=][ \t]*)([^\s,;\"']+)"#,
            "$1$2[REDACTED]",
        );
        apply(
            r"\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b",
            "[REDACTED_TOKEN]",
        );
    }
    if config.email_addresses {
        apply(
            r"\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
            "[REDACTED_EMAIL]",
        );
    }
    if config.home_paths {
        apply(r#"/(?:Users|home)/[^/\s\"']+"#, "/home/[REDACTED_USER]");
        apply(
            r#"(?i)[A-Z]:\\Users\\[^\\\s\"']+"#,
            "C:\\Users\\[REDACTED_USER]",
        );
    }
    RedactedBytes {
        bytes: text.into_bytes(),
        replacements,
    }
}

fn redact_artifact(
    path: &Path,
    bytes: &[u8],
    config: RedactionConfig,
) -> Result<RedactedBytes, DaemonError> {
    if !config.enabled() {
        return Ok(RedactedBytes {
            bytes: bytes.to_vec(),
            replacements: 0,
        });
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "db" | "sqlite" | "sqlite3" | "pb" | "protobuf"
    ) {
        return Err(DaemonError::UnsupportedRedaction(path.to_path_buf()));
    }
    if extension == "zip" {
        return redact_zip(path, bytes, config);
    }
    Ok(redact_bytes(bytes, config))
}

fn redact_zip(
    path: &Path,
    bytes: &[u8],
    config: RedactionConfig,
) -> Result<RedactedBytes, DaemonError> {
    const MAX_ENTRIES: usize = 4096;
    const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
    const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|error| DaemonError::Zip {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    if archive.len() > MAX_ENTRIES {
        return Err(DaemonError::Zip {
            path: path.to_path_buf(),
            message: format!("archive exceeds {MAX_ENTRIES} entries"),
        });
    }
    let output = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(output);
    let mut replacements = 0_u32;
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| DaemonError::Zip {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?;
        let name = entry.name().to_owned();
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(entry.compression())
            .unix_permissions(entry.unix_mode().unwrap_or(0o600));
        if entry.is_dir() {
            writer
                .add_directory(name, options)
                .map_err(|error| DaemonError::Zip {
                    path: path.to_path_buf(),
                    message: error.to_string(),
                })?;
            continue;
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(DaemonError::Zip {
                path: path.to_path_buf(),
                message: format!("entry {name} exceeds size limit"),
            });
        }
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_BYTES {
            return Err(DaemonError::Zip {
                path: path.to_path_buf(),
                message: "archive exceeds total uncompressed size limit".to_owned(),
            });
        }
        let virtual_path = Path::new(&name);
        let extension = virtual_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            extension.as_str(),
            "db" | "sqlite" | "sqlite3" | "pb" | "protobuf" | "zip"
        ) {
            return Err(DaemonError::UnsupportedRedaction(PathBuf::from(format!(
                "{}::{name}",
                path.display()
            ))));
        }
        let mut entry_bytes = Vec::new();
        entry
            .read_to_end(&mut entry_bytes)
            .map_err(|source| DaemonError::Io {
                path: PathBuf::from(format!("{}::{name}", path.display())),
                source,
            })?;
        let redacted = redact_bytes(&entry_bytes, config);
        replacements = replacements.saturating_add(redacted.replacements);
        writer
            .start_file(name, options)
            .map_err(|error| DaemonError::Zip {
                path: path.to_path_buf(),
                message: error.to_string(),
            })?;
        writer
            .write_all(&redacted.bytes)
            .map_err(|source| DaemonError::Io {
                path: path.to_path_buf(),
                source,
            })?;
    }
    if replacements == 0 {
        return Ok(RedactedBytes {
            bytes: bytes.to_vec(),
            replacements: 0,
        });
    }
    let bytes = writer
        .finish()
        .map_err(|error| DaemonError::Zip {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?
        .into_inner();
    Ok(RedactedBytes {
        bytes,
        replacements,
    })
}

pub struct OfflineQueue {
    connection: Connection,
    blob_dir: PathBuf,
}

impl OfflineQueue {
    pub fn open(path: &Path) -> Result<Self, DaemonError> {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(|source| DaemonError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
        let blob_dir = parent.join("blobs");
        fs::create_dir_all(&blob_dir).map_err(|source| DaemonError::Io {
            path: blob_dir.clone(),
            source,
        })?;
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS metadata (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS artifacts (
               sha256 TEXT NOT NULL,
               source_path TEXT NOT NULL,
               size INTEGER NOT NULL,
               source TEXT NOT NULL,
               local_path TEXT NOT NULL,
               modified_at TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               attempts INTEGER NOT NULL DEFAULT 0,
               last_error TEXT,
               queued_at TEXT NOT NULL,
               synced_at TEXT,
               redacted INTEGER NOT NULL DEFAULT 0,
               redaction_count INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (sha256, source_path)
             );
             CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status, queued_at);",
        )?;
        ensure_column(
            &connection,
            "artifacts",
            "redacted",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "artifacts",
            "redaction_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        connection.execute(
            "INSERT INTO metadata(key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
        Ok(Self {
            connection,
            blob_dir,
        })
    }

    pub fn enqueue(&self, source: &str, path: &Path) -> Result<QueuedArtifact, DaemonError> {
        self.enqueue_with_redaction(source, path, RedactionConfig::disabled())
    }

    pub fn enqueue_with_redaction(
        &self,
        source: &str,
        path: &Path,
        redaction: RedactionConfig,
    ) -> Result<QueuedArtifact, DaemonError> {
        let source_bytes = fs::read(path).map_err(|source| DaemonError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let metadata = fs::metadata(path).map_err(|source| DaemonError::Io {
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
                transformed.bytes.len() as u64,
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

    pub fn pending(&self, limit: usize) -> Result<Vec<QueuedArtifact>, DaemonError> {
        let mut statement = self.connection.prepare(
            "SELECT sha256, size, source, source_path, local_path, modified_at,
                    status, attempts, last_error, redacted, redaction_count
             FROM artifacts
             WHERE status IN ('pending', 'retry')
             ORDER BY queued_at ASC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit as u64], row_to_artifact)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn counts(&self) -> Result<QueueCounts, DaemonError> {
        let count = |status: &str| -> Result<u64, rusqlite::Error> {
            self.connection.query_row(
                "SELECT COUNT(*) FROM artifacts WHERE status = ?1",
                [status],
                |row| row.get(0),
            )
        };
        Ok(QueueCounts {
            pending: count("pending")?,
            retry: count("retry")?,
            synced: count("synced")?,
        })
    }

    pub fn mark_synced(&self, sha256: &str) -> Result<(), DaemonError> {
        self.connection.execute(
            "UPDATE artifacts SET status = 'synced', synced_at = ?2, last_error = NULL
             WHERE sha256 = ?1",
            params![sha256, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn mark_retry(&self, sha256: &str, message: &str) -> Result<(), DaemonError> {
        self.connection.execute(
            "UPDATE artifacts SET status = 'retry', attempts = attempts + 1, last_error = ?2
             WHERE sha256 = ?1",
            params![sha256, message],
        )?;
        Ok(())
    }

    fn mark_retry_all(
        &self,
        artifacts: &[QueuedArtifact],
        message: &str,
    ) -> Result<(), DaemonError> {
        for artifact in artifacts {
            self.mark_retry(&artifact.sha256, message)?;
        }
        Ok(())
    }

    pub fn integrity_check(&self) -> Result<bool, DaemonError> {
        let result: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        Ok(result == "ok")
    }

    fn get(&self, sha256: &str, source_path: &str) -> Result<Option<QueuedArtifact>, DaemonError> {
        self.connection
            .query_row(
                "SELECT sha256, size, source, source_path, local_path, modified_at,
                        status, attempts, last_error, redacted, redaction_count
                 FROM artifacts WHERE sha256 = ?1 AND source_path = ?2",
                params![sha256, source_path],
                row_to_artifact,
            )
            .optional()
            .map_err(Into::into)
    }
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), rusqlite::Error> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|candidate| candidate == column) {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
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

fn row_to_artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<QueuedArtifact> {
    let status: String = row.get(6)?;
    Ok(QueuedArtifact {
        sha256: row.get(0)?,
        size: row.get(1)?,
        source: row.get(2)?,
        source_path: row.get(3)?,
        local_path: PathBuf::from(row.get::<_, String>(4)?),
        modified_at: row.get(5)?,
        status: QueueStatus::parse(&status),
        attempts: row.get(7)?,
        last_error: row.get(8)?,
        redacted: row.get(9)?,
        redaction_count: row.get(10)?,
    })
}

#[must_use]
pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestArtifact {
    pub sha256: String,
    pub size: u64,
    pub source: String,
    pub source_path: String,
    pub modified_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestManifest {
    pub machine_id: String,
    pub batch_id: String,
    pub artifacts: Vec<ManifestArtifact>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestReceipt {
    pub batch_id: String,
    pub accepted: u64,
    pub duplicate: u64,
    pub queued_at: String,
}

pub trait SyncTransport {
    fn missing(&self, machine_id: &str, hashes: &[String]) -> Result<HashSet<String>, DaemonError>;
    fn upload(&self, artifact: &QueuedArtifact, bytes: Vec<u8>) -> Result<(), DaemonError>;
    fn submit_manifest(&self, manifest: &IngestManifest) -> Result<IngestReceipt, DaemonError>;
}

pub struct HttpTransport {
    client: Client,
    endpoint: String,
    machine_token: String,
}

impl HttpTransport {
    #[must_use]
    pub fn new(endpoint: impl Into<String>, machine_token: impl Into<String>) -> Self {
        Self {
            client: Client::new(),
            endpoint: endpoint.into().trim_end_matches('/').to_owned(),
            machine_token: machine_token.into(),
        }
    }

    fn authorize(
        &self,
        request: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        request.bearer_auth(&self.machine_token)
    }
}

impl SyncTransport for HttpTransport {
    fn missing(&self, machine_id: &str, hashes: &[String]) -> Result<HashSet<String>, DaemonError> {
        let response = self
            .authorize(self.client.post(format!("{}/ingest/delta", self.endpoint)))
            .json(&serde_json::json!({ "machineId": machine_id, "hashes": hashes }))
            .send()
            .map_err(|error| DaemonError::Transport(error.to_string()))?;
        let response = require_success(response)?;
        #[derive(Deserialize)]
        struct Delta {
            missing: Vec<String>,
        }
        response
            .json::<Delta>()
            .map(|delta| delta.missing.into_iter().collect())
            .map_err(|error| DaemonError::Protocol(error.to_string()))
    }

    fn upload(&self, artifact: &QueuedArtifact, bytes: Vec<u8>) -> Result<(), DaemonError> {
        let response = self
            .authorize(self.client.put(format!(
                "{}/ingest/artifacts/{}",
                self.endpoint, artifact.sha256
            )))
            .header("x-memoar-source", &artifact.source)
            .header("x-memoar-source-path", &artifact.source_path)
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .map_err(|error| DaemonError::Transport(error.to_string()))?;
        require_success(response).map(|_| ())
    }

    fn submit_manifest(&self, manifest: &IngestManifest) -> Result<IngestReceipt, DaemonError> {
        let response = self
            .authorize(
                self.client
                    .post(format!("{}/ingest/manifests", self.endpoint)),
            )
            .json(manifest)
            .send()
            .map_err(|error| DaemonError::Transport(error.to_string()))?;
        require_success(response)?
            .json::<IngestReceipt>()
            .map_err(|error| DaemonError::Protocol(error.to_string()))
    }
}

fn require_success(
    response: reqwest::blocking::Response,
) -> Result<reqwest::blocking::Response, DaemonError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().unwrap_or_default();
    Err(DaemonError::Transport(format!("HTTP {status}: {body}")))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub batch_id: Option<String>,
    pub considered: usize,
    pub uploaded: usize,
    pub duplicates: usize,
}

pub struct SyncEngine<T> {
    transport: T,
    batch_limit: usize,
}

impl<T: SyncTransport> SyncEngine<T> {
    #[must_use]
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            batch_limit: 256,
        }
    }

    pub fn sync(&self, queue: &OfflineQueue, machine_id: &str) -> Result<SyncReport, DaemonError> {
        let artifacts = queue.pending(self.batch_limit)?;
        if artifacts.is_empty() {
            return Ok(SyncReport {
                batch_id: None,
                considered: 0,
                uploaded: 0,
                duplicates: 0,
            });
        }
        let hashes: Vec<_> = artifacts
            .iter()
            .map(|artifact| artifact.sha256.clone())
            .collect();
        let missing = match self.transport.missing(machine_id, &hashes) {
            Ok(missing) => missing,
            Err(error) => {
                queue.mark_retry_all(&artifacts, &error.to_string())?;
                return Err(error);
            }
        };
        let mut uploaded = 0;
        for artifact in &artifacts {
            if !missing.contains(&artifact.sha256) {
                continue;
            }
            let bytes = match fs::read(&artifact.local_path) {
                Ok(bytes) => bytes,
                Err(source) => {
                    let error = DaemonError::Io {
                        path: artifact.local_path.clone(),
                        source,
                    };
                    queue.mark_retry(&artifact.sha256, &error.to_string())?;
                    return Err(error);
                }
            };
            if sha256_bytes(&bytes) != artifact.sha256 {
                let error = DaemonError::Protocol(format!(
                    "queued blob {} failed SHA-256 verification",
                    artifact.sha256
                ));
                queue.mark_retry(&artifact.sha256, &error.to_string())?;
                return Err(error);
            }
            if let Err(error) = self.transport.upload(artifact, bytes) {
                queue.mark_retry(&artifact.sha256, &error.to_string())?;
                return Err(error);
            }
            uploaded += 1;
        }
        let batch_id = Uuid::now_v7().to_string();
        let manifest = IngestManifest {
            machine_id: machine_id.to_owned(),
            batch_id: batch_id.clone(),
            artifacts: artifacts
                .iter()
                .map(|artifact| ManifestArtifact {
                    sha256: artifact.sha256.clone(),
                    size: artifact.size,
                    source: artifact.source.clone(),
                    source_path: artifact.source_path.clone(),
                    modified_at: artifact.modified_at.clone(),
                })
                .collect(),
        };
        let receipt = match self.transport.submit_manifest(&manifest) {
            Ok(receipt) => receipt,
            Err(error) => {
                queue.mark_retry_all(&artifacts, &error.to_string())?;
                return Err(error);
            }
        };
        let receipt_total = receipt.accepted.saturating_add(receipt.duplicate);
        if receipt.batch_id != batch_id || receipt_total != artifacts.len() as u64 {
            let error = DaemonError::Protocol(format!(
                "manifest receipt mismatch: batch {} accepted {} duplicate {} for {} artifacts",
                receipt.batch_id,
                receipt.accepted,
                receipt.duplicate,
                artifacts.len()
            ));
            queue.mark_retry_all(&artifacts, &error.to_string())?;
            return Err(error);
        }
        for hash in &hashes {
            queue.mark_synced(hash)?;
        }
        Ok(SyncReport {
            batch_id: Some(batch_id),
            considered: artifacts.len(),
            uploaded,
            duplicates: artifacts.len() - uploaded,
        })
    }
}

pub fn capture_sources(
    queue: &OfflineQueue,
    home: &Path,
    os: OperatingSystem,
    enabled_sources: &HashSet<String>,
) -> Result<usize, DaemonError> {
    capture_sources_with_redaction(
        queue,
        home,
        os,
        enabled_sources,
        RedactionConfig::disabled(),
    )
}

pub fn capture_sources_with_redaction(
    queue: &OfflineQueue,
    home: &Path,
    os: OperatingSystem,
    enabled_sources: &HashSet<String>,
    redaction: RedactionConfig,
) -> Result<usize, DaemonError> {
    let mut captured = 0;
    for spec in SOURCES {
        if !enabled_sources.is_empty() && !enabled_sources.contains(spec.id) {
            continue;
        }
        for path in files_for_source(spec, home, os)? {
            queue.enqueue_with_redaction(spec.id, &path, redaction)?;
            captured += 1;
        }
    }
    Ok(captured)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileFingerprint {
    pub len: u64,
    pub modified: SystemTime,
}

#[derive(Debug)]
struct Observation {
    fingerprint: FileFingerprint,
    stable_since: SystemTime,
    emitted: bool,
}

/// Debounce primitive for polling watchers. A path is emitted once after its
/// size and modification time remain unchanged for the configured interval.
pub struct DebouncedChanges {
    debounce: Duration,
    observations: HashMap<PathBuf, Observation>,
}

impl DebouncedChanges {
    #[must_use]
    pub fn new(debounce: Duration) -> Self {
        Self {
            debounce,
            observations: HashMap::new(),
        }
    }

    pub fn observe(
        &mut self,
        path: PathBuf,
        fingerprint: FileFingerprint,
        now: SystemTime,
    ) -> bool {
        let observation = self.observations.entry(path).or_insert(Observation {
            fingerprint,
            stable_since: now,
            emitted: false,
        });
        if observation.fingerprint != fingerprint {
            observation.fingerprint = fingerprint;
            observation.stable_since = now;
            observation.emitted = false;
            return false;
        }
        if observation.emitted
            || now
                .duration_since(observation.stable_since)
                .unwrap_or_default()
                < self.debounce
        {
            return false;
        }
        observation.emitted = true;
        true
    }
}

/// Stateful polling watcher used by the daemon loop. Files are queued only
/// after a stable debounce window; subsequent mutations reset that window.
pub struct PollingCapture {
    changes: DebouncedChanges,
}

impl PollingCapture {
    #[must_use]
    pub fn new(debounce: Duration) -> Self {
        Self {
            changes: DebouncedChanges::new(debounce),
        }
    }

    pub fn scan(
        &mut self,
        queue: &OfflineQueue,
        home: &Path,
        os: OperatingSystem,
        enabled_sources: &HashSet<String>,
        redaction: RedactionConfig,
        now: SystemTime,
    ) -> Result<usize, DaemonError> {
        let mut captured = 0;
        for spec in SOURCES {
            if !enabled_sources.is_empty() && !enabled_sources.contains(spec.id) {
                continue;
            }
            for path in files_for_source(spec, home, os)? {
                let metadata = fs::metadata(&path).map_err(|source| DaemonError::Io {
                    path: path.clone(),
                    source,
                })?;
                let fingerprint = FileFingerprint {
                    len: metadata.len(),
                    modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                };
                if self.changes.observe(path.clone(), fingerprint, now) {
                    queue.enqueue_with_redaction(spec.id, &path, redaction)?;
                    captured += 1;
                }
            }
        }
        Ok(captured)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeTransport {
        uploaded: Mutex<Vec<Vec<u8>>>,
        fail_manifest: bool,
        partial_receipt: bool,
    }

    impl SyncTransport for FakeTransport {
        fn missing(
            &self,
            _machine_id: &str,
            hashes: &[String],
        ) -> Result<HashSet<String>, DaemonError> {
            Ok(hashes.iter().cloned().collect())
        }

        fn upload(&self, _artifact: &QueuedArtifact, bytes: Vec<u8>) -> Result<(), DaemonError> {
            self.uploaded.lock().unwrap().push(bytes);
            Ok(())
        }

        fn submit_manifest(&self, manifest: &IngestManifest) -> Result<IngestReceipt, DaemonError> {
            if self.fail_manifest {
                return Err(DaemonError::Transport("offline".to_owned()));
            }
            Ok(IngestReceipt {
                batch_id: manifest.batch_id.clone(),
                accepted: if self.partial_receipt {
                    0
                } else {
                    manifest.artifacts.len() as u64
                },
                duplicate: 0,
                queued_at: Utc::now().to_rfc3339(),
            })
        }
    }

    #[test]
    fn fixture_home_captures_and_syncs_immutable_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let source = home.join(".claude/projects/-workspace/session.jsonl");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "first").unwrap();
        let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
        let enabled = HashSet::from(["claude-code".to_owned()]);
        assert_eq!(
            capture_sources(&queue, &home, OperatingSystem::Linux, &enabled).unwrap(),
            1
        );
        fs::write(&source, "changed after enqueue").unwrap();

        let transport = FakeTransport::default();
        let report = SyncEngine::new(transport)
            .sync(&queue, "00000000-0000-4000-8000-000000000001")
            .unwrap();
        assert_eq!(report.uploaded, 1);
        let batch_id = Uuid::parse_str(report.batch_id.as_deref().unwrap()).unwrap();
        assert_eq!(batch_id.get_version_num(), 7);
        assert_eq!(queue.counts().unwrap().synced, 1);
        assert!(queue.integrity_check().unwrap());
    }

    #[test]
    fn client_redaction_happens_before_hashing_and_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("session.jsonl");
        fs::write(
            &source,
            "api_key=super-secret-value user=person@example.com /Users/alice/project",
        )
        .unwrap();
        let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
        let artifact = queue
            .enqueue_with_redaction(
                "fixture",
                &source,
                RedactionConfig {
                    secrets: true,
                    email_addresses: true,
                    home_paths: true,
                },
            )
            .unwrap();
        let bytes = fs::read(&artifact.local_path).unwrap();
        let content = String::from_utf8(bytes).unwrap();
        assert!(artifact.redacted);
        assert!(artifact.redaction_count >= 3);
        assert!(!content.contains("super-secret-value"));
        assert!(!content.contains("person@example.com"));
        assert!(!content.contains("/Users/alice"));
        assert_eq!(artifact.sha256, sha256_bytes(content.as_bytes()));
    }

    #[test]
    fn failed_manifest_remains_resumable_in_retry_state() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("session.jsonl");
        fs::write(&source, "queued").unwrap();
        let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
        queue.enqueue("fixture", &source).unwrap();
        let error = SyncEngine::new(FakeTransport {
            fail_manifest: true,
            ..FakeTransport::default()
        })
        .sync(&queue, "machine")
        .unwrap_err();
        assert!(error.to_string().contains("offline"));
        let pending = queue.pending(10).unwrap();
        assert_eq!(pending[0].status, QueueStatus::Retry);
        assert_eq!(pending[0].attempts, 1);
    }

    #[test]
    fn partial_receipt_keeps_artifacts_queued() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("session.jsonl");
        fs::write(&source, "queued").unwrap();
        let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
        queue.enqueue("fixture", &source).unwrap();
        let error = SyncEngine::new(FakeTransport {
            partial_receipt: true,
            ..FakeTransport::default()
        })
        .sync(&queue, "machine")
        .unwrap_err();
        assert!(error.to_string().contains("receipt mismatch"));
        let pending = queue.pending(10).unwrap();
        assert_eq!(pending[0].status, QueueStatus::Retry);
        assert_eq!(pending[0].attempts, 1);
    }

    #[test]
    fn watcher_emits_only_after_stability_window() {
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        let fingerprint = FileFingerprint {
            len: 10,
            modified: start,
        };
        let mut watcher = DebouncedChanges::new(Duration::from_secs(2));
        let path = PathBuf::from("session.jsonl");
        assert!(!watcher.observe(path.clone(), fingerprint, start));
        assert!(!watcher.observe(path.clone(), fingerprint, start + Duration::from_secs(1)));
        assert!(watcher.observe(path.clone(), fingerprint, start + Duration::from_secs(2)));
        assert!(!watcher.observe(path, fingerprint, start + Duration::from_secs(3)));
    }

    #[test]
    fn polling_capture_debounces_real_fixture_file() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("fixture-home");
        let source = home.join(".claude/projects/-workspace/session.jsonl");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "one").unwrap();
        let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
        let enabled = HashSet::from(["claude-code".to_owned()]);
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        let mut capture = PollingCapture::new(Duration::from_secs(2));
        assert_eq!(
            capture
                .scan(
                    &queue,
                    &home,
                    OperatingSystem::Linux,
                    &enabled,
                    RedactionConfig::disabled(),
                    start,
                )
                .unwrap(),
            0
        );
        assert_eq!(
            capture
                .scan(
                    &queue,
                    &home,
                    OperatingSystem::Linux,
                    &enabled,
                    RedactionConfig::disabled(),
                    start + Duration::from_secs(2),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn zip_redaction_repacks_entries_with_limits() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("session.zip");
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        writer
            .start_file("session.jsonl", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"api_key=super-secret-value").unwrap();
        let archive = writer.finish().unwrap().into_inner();
        fs::write(&source, archive).unwrap();

        let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
        let artifact = queue
            .enqueue_with_redaction(
                "fixture",
                &source,
                RedactionConfig {
                    secrets: true,
                    ..RedactionConfig::disabled()
                },
            )
            .unwrap();
        let bytes = fs::read(artifact.local_path).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut content = String::new();
        archive
            .by_name("session.jsonl")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert!(!content.contains("super-secret-value"));
        assert!(content.contains("[REDACTED]"));
    }

    #[test]
    fn opaque_sqlite_redaction_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("session.db");
        fs::write(&source, b"SQLite format 3\0opaque").unwrap();
        let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
        assert!(matches!(
            queue.enqueue_with_redaction(
                "fixture",
                &source,
                RedactionConfig {
                    secrets: true,
                    ..RedactionConfig::disabled()
                }
            ),
            Err(DaemonError::UnsupportedRedaction(_))
        ));
        assert_eq!(queue.counts().unwrap().pending, 0);
    }
}
