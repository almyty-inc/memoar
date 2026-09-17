//! Local capture, immutable offline queueing, optional redaction, and delta sync.

pub mod memory;

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
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use thiserror::Error;
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 3;

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
    #[error(
        "{path} is not valid UTF-8 and matched a redaction pattern, so it cannot be rewritten safely"
    )]
    UnscannableSecret { path: PathBuf },
    #[error("client redaction is unsupported for opaque artifact {0}")]
    UnsupportedRedaction(PathBuf),
    #[error("ZIP redaction failed for {path}: {message}")]
    Zip { path: PathBuf, message: String },
    #[error("{path} is {size} bytes, past the {limit}-byte ceiling the archive accepts")]
    TooLarge {
        path: PathBuf,
        size: u64,
        limit: u64,
    },
}

impl DaemonError {
    /// Redaction was asked for and cannot be applied to this artifact.
    ///
    /// Three variants mean the same thing to a caller: the file stays on the
    /// machine. They are named in one place because handling two of the three
    /// is how a Zed write-ahead log went on aborting the whole capture after
    /// the other two had been fixed.
    pub fn is_unredactable(&self) -> bool {
        matches!(
            self,
            DaemonError::UnscannableSecret { .. }
                | DaemonError::UnsupportedRedaction(_)
                | DaemonError::Zip { .. }
        )
    }

    /// This artifact is not going anywhere, and that must not cost the caller
    /// every other artifact in the pass.
    ///
    /// Redaction is one reason a file stays behind; being larger than the
    /// archive will accept is another, and the capture loop has to treat them
    /// alike. Handling only the redaction half is how a Zed write-ahead log
    /// used to end a whole sweep, and a 500 MB stray file would do it again
    /// through the other door.
    pub fn is_skippable(&self) -> bool {
        self.is_unredactable() || matches!(self, DaemonError::TooLarge { .. })
    }
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
    /// False when the bytes could not be read as text, so no pattern was applied.
    scanned: bool,
    bytes: Vec<u8>,
    replacements: u32,
}

fn redact_bytes(bytes: &[u8], config: RedactionConfig) -> RedactedBytes {
    if !config.enabled() {
        return RedactedBytes {
            bytes: bytes.to_vec(),
            replacements: 0,
            scanned: true,
        };
    }
    let Ok(mut text) = String::from_utf8(bytes.to_vec()) else {
        // Not text we can rewrite. Returning the bytes untouched here is what
        // the caller must not do silently: see redact_artifact, which scans a
        // lossy view and refuses the artifact if anything matches.
        return RedactedBytes {
            bytes: bytes.to_vec(),
            replacements: 0,
            scanned: false,
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
        // The key/value shape as people actually write it, rather than as it
        // appears in a shell one-liner.
        //
        // The old pattern anchored the key name with `\b` and excluded quotes
        // from the value, so it caught `api_key=abc` and almost nothing else on
        // a real machine: `"api_key": "sk-live-..."` never matched, because the
        // value group could not start on a quote; `export OPENAI_API_KEY="..."`
        // and `AWS_SECRET_ACCESS_KEY=...` never matched, because `\b` does not
        // fire between `_` and a letter. JSONL is the primary format of several
        // capture sources, so the quoted form is the ordinary one — and the
        // artifact was then filed as `redacted: false, redaction_count: 0`,
        // which is the worst available outcome: a secret uploaded under a
        // receipt saying there was nothing to find.
        //
        // So the key name may carry a prefix and a suffix, and the separator
        // may carry the quote on either side. The value stops before the
        // closing quote, which is left where it was, so `"k": "v"` comes out as
        // well-formed JSON.
        apply(
            r#"(?i)([A-Za-z0-9_.-]{0,40}(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)[A-Za-z0-9_.-]{0,40})(["']?[ \t]*[:=][ \t]*["']?)([^\s"',;{}\[\]]+)"#,
            "${1}${2}[REDACTED]",
        );
        // `Authorization: Bearer abcdef123456`, and the header's JSON form.
        //
        // Anchored on the header name rather than on the word `Bearer`: a bare
        // scheme word is ordinary English, and redacting whatever follows
        // "bearer" or "basic" would eat its way through prose. Anchored the
        // other way round, the scheme word has to be stepped over explicitly or
        // the credential survives with only `Bearer` removed.
        apply(
            r#"(?i)((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)((?:bearer|basic|token)[ \t]+)?([^\s"',;{}\[\]]+)"#,
            "${1}${2}[REDACTED]",
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
        scanned: true,
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
            scanned: true,
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
    let redacted = redact_bytes(bytes, config);
    if !redacted.scanned && contains_secret_lossy(bytes, config) {
        // The bytes are not valid UTF-8, so no pattern could be applied to
        // them, and a lossy read shows something that should have been
        // removed. Rewriting a lossy view would corrupt the artifact, so this
        // refuses it the same way an opaque database is refused. Silently
        // uploading an unscanned file is the one outcome redaction must not
        // have.
        return Err(DaemonError::UnscannableSecret {
            path: path.to_path_buf(),
        });
    }
    Ok(redacted)
}

/// Whether a lossy reading of non-UTF-8 bytes trips any enabled pattern.
///
/// Used only to decide whether to refuse an artifact, never to rewrite one:
/// replacing text in a lossy view and writing it back would mangle every byte
/// that did not survive the conversion.
fn contains_secret_lossy(bytes: &[u8], config: RedactionConfig) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let probe = redact_bytes(text.as_bytes(), config);
    probe.replacements > 0
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
        if !redacted.scanned && contains_secret_lossy(&entry_bytes, config) {
            // The same refusal the top level makes, for the same reason. This
            // branch only looked at `.replacements`, so an entry that could not
            // be read as text was repacked exactly as found and shipped with
            // `redacted: false` — a member of an archive was the one place an
            // unscanned secret could still get out.
            return Err(DaemonError::UnscannableSecret {
                path: PathBuf::from(format!("{}::{name}", path.display())),
            });
        }
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
            scanned: true,
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
        scanned: true,
    })
}

/// How many times one artifact is offered to the server before the queue stops
/// offering it.
///
/// An artifact the server will never accept — the wrong shape, past a limit the
/// ingress enforces and the agent does not — is not made acceptable by a ninth
/// try. Counting the attempts was already being done; this is the number that
/// was missing.
pub const MAX_ATTEMPTS: u32 = 8;

/// The wait after the first failure, doubled each time up to `MAX_RETRY_BACKOFF`.
const RETRY_BACKOFF: Duration = Duration::from_secs(60);

/// A ceiling on the doubling: an artifact that fails all day should still be
/// tried tomorrow morning without waiting a week for it.
const MAX_RETRY_BACKOFF: Duration = Duration::from_secs(6 * 60 * 60);

/// How long an artifact waits after its `attempts`-th failure.
fn retry_delay(attempts: u32) -> Duration {
    let doublings = attempts.saturating_sub(1).min(16);
    RETRY_BACKOFF
        .saturating_mul(1_u32 << doublings)
        .min(MAX_RETRY_BACKOFF)
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
               next_attempt_at TEXT,
               PRIMARY KEY (sha256, source_path)
             );
             CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status, attempts, queued_at);",
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
        ensure_column(&connection, "artifacts", "next_attempt_at", "TEXT")?;
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

    pub fn pending(&self, limit: usize) -> Result<Vec<QueuedArtifact>, DaemonError> {
        self.pending_at(limit, Utc::now())
    }

    /// What this pass may try, as of a given instant.
    ///
    /// Three things were missing here and they composed into one failure.
    /// `attempts` was incremented and never read, so nothing ever gave up.
    /// `mark_retry` left `queued_at` alone, so a rejected artifact kept the
    /// oldest timestamp in the table. And the order was `queued_at ASC` with a
    /// limit of 256. Two hundred and fifty-six artifacts the server would never
    /// accept therefore sat at the head of the queue forever, were re-offered
    /// in full on every single pass, and no session captured afterwards was
    /// ever looked at again.
    ///
    /// So: artifacts past the cap are done being tried, a failed artifact waits
    /// out its backoff, and what has failed least goes first — a fresh capture
    /// can never queue behind something that has already been refused.
    pub fn pending_at(
        &self,
        limit: usize,
        now: DateTime<Utc>,
    ) -> Result<Vec<QueuedArtifact>, DaemonError> {
        let mut statement = self.connection.prepare(
            "SELECT sha256, size, source, source_path, local_path, modified_at,
                    status, attempts, last_error, redacted, redaction_count
             FROM artifacts
             WHERE status IN ('pending', 'retry')
               AND attempts < ?2
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)
             ORDER BY attempts ASC, queued_at ASC
             LIMIT ?1",
        )?;
        let rows = statement.query_map(
            params![limit as i64, MAX_ATTEMPTS, now.to_rfc3339()],
            row_to_artifact,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Artifacts that have used up every attempt they are going to get.
    pub fn abandoned(&self) -> Result<u64, DaemonError> {
        let value: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM artifacts WHERE status != 'synced' AND attempts >= ?1",
            [MAX_ATTEMPTS],
            |row| row.get(0),
        )?;
        Ok(value.max(0) as u64)
    }

    pub fn counts(&self) -> Result<QueueCounts, DaemonError> {
        // SQLite integers are signed, and rusqlite 0.40 stopped pretending
        // otherwise. A row count cannot be negative, so the conversion is
        // stated here rather than implied by a type that never fitted.
        let count = |status: &str| -> Result<u64, rusqlite::Error> {
            let value: i64 = self.connection.query_row(
                "SELECT COUNT(*) FROM artifacts WHERE status = ?1",
                [status],
                |row| row.get(0),
            )?;
            Ok(value.max(0) as u64)
        };
        Ok(QueueCounts {
            pending: count("pending")?,
            retry: count("retry")?,
            synced: count("synced")?,
        })
    }

    /// Identified by the whole primary key, never by the hash alone.
    ///
    /// The same bytes reached from two places are two rows — the archive wants
    /// both source paths, because where a transcript was found is part of what
    /// it is. Keying on `sha256` alone marked every one of those rows synced
    /// off the back of one upload, and the provenance of the others was never
    /// sent at all.
    pub fn mark_synced(&self, sha256: &str, source_path: &str) -> Result<(), DaemonError> {
        self.connection.execute(
            "UPDATE artifacts SET status = 'synced', synced_at = ?3, last_error = NULL
             WHERE sha256 = ?1 AND source_path = ?2",
            params![sha256, source_path, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn mark_retry(
        &self,
        sha256: &str,
        source_path: &str,
        message: &str,
    ) -> Result<(), DaemonError> {
        let previous: i64 = self
            .connection
            .query_row(
                "SELECT attempts FROM artifacts WHERE sha256 = ?1 AND source_path = ?2",
                params![sha256, source_path],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let attempts = (previous.max(0) as u32).saturating_add(1);
        let delay = chrono::Duration::from_std(retry_delay(attempts))
            .unwrap_or_else(|_| chrono::Duration::zero());
        self.connection.execute(
            "UPDATE artifacts
             SET status = 'retry', attempts = ?3, last_error = ?4, next_attempt_at = ?5
             WHERE sha256 = ?1 AND source_path = ?2",
            params![
                sha256,
                source_path,
                attempts,
                message,
                (Utc::now() + delay).to_rfc3339()
            ],
        )?;
        Ok(())
    }

    fn mark_retry_all(
        &self,
        artifacts: &[QueuedArtifact],
        message: &str,
    ) -> Result<(), DaemonError> {
        for artifact in artifacts {
            self.mark_retry(&artifact.sha256, &artifact.source_path, message)?;
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
        size: row.get::<_, i64>(1)?.max(0) as u64,
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

/// The machine token the transport is currently using, and when it dies.
struct Credential {
    token: String,
    expires_at: Option<DateTime<Utc>>,
}

/// Mints a fresh machine token. Supplied by the caller, because minting needs
/// the account credential and that lives a layer up.
pub type TokenMinter = Box<dyn Fn() -> Result<(String, Option<String>), DaemonError> + Send + Sync>;

/// How much life a machine token must have left before a request will use it.
///
/// A machine token lives 900 seconds. A single upload may run for
/// `UPLOAD_TIMEOUT`. The server validates the bearer once the body has
/// arrived, so a large transcript pushed on a token minted at the start of a
/// batch was authenticated against a credential that had already expired —
/// twenty-six artifacts in a real drain died on
/// `401 Valid bearer, machine, or API-key credentials are required`, having
/// uploaded every byte first.
///
/// Re-minting before each request cannot make a token outlive its own TTL, so
/// an upload slower than the full lifetime still cannot be authenticated. What
/// it does guarantee is that no request ever *starts* on a credential that is
/// about to die, which is what was actually happening.
const CREDENTIAL_MARGIN: Duration = Duration::from_secs(300);

pub struct HttpTransport {
    client: Client,
    endpoint: String,
    credential: Mutex<Credential>,
    mint: Option<TokenMinter>,
}

/// The largest artifact the archive accepts, mirroring `MEMOAR_MAX_ARTIFACT_BYTES`
/// on the API and `proxy-body-size` on the ingress.
pub const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;

/// The slowest uplink an upload is still expected to finish on: 2 Mbit/s.
/// Below this the agent is entitled to give up; at or above it, a timeout that
/// fires is a bug in the timeout, not a slow network.
pub const SLOWEST_TOLERATED_UPLOAD_BYTES_PER_SEC: u64 = 256 * 1024;

/// How long a single artifact upload may take.
///
/// This is not a free parameter: it has to cover `MAX_ARTIFACT_BYTES` at
/// `SLOWEST_TOLERATED_UPLOAD_BYTES_PER_SEC`, and a test holds it to that. The
/// reqwest default of 30 seconds did not, so every transcript over roughly
/// 30 MB failed on a deadline it could never meet and retried forever.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// A dead host should not cost a whole upload budget to discover.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

impl HttpTransport {
    #[must_use]
    pub fn new(endpoint: impl Into<String>, machine_token: impl Into<String>) -> Self {
        Self::with_minter(endpoint, machine_token, None, None)
    }

    /// A transport that can replace its own machine token when the one it holds
    /// is close to expiry.
    #[must_use]
    pub fn with_minter(
        endpoint: impl Into<String>,
        machine_token: impl Into<String>,
        expires_at: Option<&str>,
        mint: Option<TokenMinter>,
    ) -> Self {
        Self {
            // `Client::new()` is a 30-second cap on the whole request, which is
            // the wrong shape for this: the payload is a transcript, and every
            // artifact that takes longer than 30 seconds to push fails, retries,
            // and fails again. Seven sessions between 26 MB and 116 MB retried
            // twenty times against a deadline none of them could ever meet.
            //
            // So: fail fast when the host is unreachable, and then let the body
            // take as long as a 256 MB ceiling needs on a domestic uplink. The
            // outer bound still exists so a stalled socket cannot hang a sync
            // forever.
            client: Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(UPLOAD_TIMEOUT)
                .tcp_keepalive(Duration::from_secs(30))
                .build()
                .expect("static HTTP client configuration must be valid"),
            endpoint: endpoint.into().trim_end_matches('/').to_owned(),
            credential: Mutex::new(Credential {
                token: machine_token.into(),
                expires_at: expires_at.and_then(parse_expiry),
            }),
            mint,
        }
    }

    /// The token to start a request with, re-minted if the one held is within
    /// `CREDENTIAL_MARGIN` of expiry.
    ///
    /// A transport with no minter keeps whatever it was given: that is the
    /// single-shot case, and failing here would turn a working call into an
    /// error over a token that may well still be good.
    fn usable_token(&self) -> Result<String, DaemonError> {
        let mut credential = self
            .credential
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(mint) = self.mint.as_ref() else {
            return Ok(credential.token.clone());
        };
        if let Some(expires_at) = credential.expires_at {
            let remaining = expires_at.signed_duration_since(Utc::now());
            if remaining
                > chrono::Duration::from_std(CREDENTIAL_MARGIN).unwrap_or(chrono::Duration::zero())
            {
                return Ok(credential.token.clone());
            }
        }
        let (token, expires_at) = mint()?;
        credential.token = token.clone();
        credential.expires_at = expires_at.as_deref().and_then(parse_expiry);
        Ok(token)
    }

    fn authorize(
        &self,
        request: reqwest::blocking::RequestBuilder,
    ) -> Result<reqwest::blocking::RequestBuilder, DaemonError> {
        Ok(request.bearer_auth(self.usable_token()?))
    }

    /// Posts JSON to a path under the endpoint and refuses anything but success.
    pub(crate) fn post_json<B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<reqwest::blocking::Response, DaemonError> {
        let response = self
            .authorize(self.client.post(format!("{}{path}", self.endpoint)))?
            .json(body)
            .send()
            .map_err(|error| transport_error(&error))?;
        require_success(response)
    }
}

/// An RFC 3339 instant, or nothing. An expiry the agent cannot read is treated
/// as no expiry rather than as an immediate one: guessing "expired" would
/// re-mint on every single request.
fn parse_expiry(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

impl SyncTransport for HttpTransport {
    fn missing(&self, machine_id: &str, hashes: &[String]) -> Result<HashSet<String>, DaemonError> {
        let response = self
            .authorize(self.client.post(format!("{}/ingest/delta", self.endpoint)))?
            .json(&serde_json::json!({ "machineId": machine_id, "hashes": hashes }))
            .send()
            .map_err(|error| transport_error(&error))?;
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
            )))?
            .header("x-memoar-source", &artifact.source)
            .header("x-memoar-source-path", &artifact.source_path)
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .map_err(|error| transport_error(&error))?;
        require_success(response).map(|_| ())
    }

    fn submit_manifest(&self, manifest: &IngestManifest) -> Result<IngestReceipt, DaemonError> {
        let response = self
            .authorize(
                self.client
                    .post(format!("{}/ingest/manifests", self.endpoint)),
            )?
            .json(manifest)
            .send()
            .map_err(|error| transport_error(&error))?;
        require_success(response)?
            .json::<IngestReceipt>()
            .map_err(|error| DaemonError::Protocol(error.to_string()))
    }
}

/// A transport failure the operator can act on.
///
/// `reqwest::Error` renders as "error sending request for url (...)" and keeps
/// the reason — connection reset, timed out, TLS — in its source chain. Seven
/// large transcripts retried twenty times against an error message that never
/// said why; the queue recorded the URL and nothing else.
fn transport_error(error: &reqwest::Error) -> DaemonError {
    let mut message = error.to_string();
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    if error.is_timeout() {
        message.push_str(" (timed out)");
    }
    DaemonError::Transport(message)
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
    /// Artifacts the server would not take. They stay queued for the next run.
    pub failed: usize,
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
                failed: 0,
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
        let mut failed = 0;
        // Counted, not derived. This was `considered - uploaded`, which quietly
        // reported every failed upload as a duplicate: a pass that lost seven
        // large transcripts to a dead connection printed "duplicates: 7" and
        // looked like a pass with nothing to do.
        let mut duplicates = 0;
        // Hashes the server does not have and this pass could not give it. The
        // manifest must not name them: it is a claim that these bytes are in
        // the archive, and the server checks.
        let mut absent: HashSet<String> = HashSet::new();
        for artifact in &artifacts {
            if !missing.contains(&artifact.sha256) {
                duplicates += 1;
                continue;
            }
            // One artifact the server will not take must not block the rest.
            //
            // Every branch here already recorded the artifact for retry and
            // then returned, so a single transcript the ingress rejected — a
            // 110 MB session against a 64 MB body limit — stopped every other
            // upload in the batch. The queue remembers; the loop carries on.
            let bytes = match fs::read(&artifact.local_path) {
                Ok(bytes) => bytes,
                Err(source) => {
                    let error = DaemonError::Io {
                        path: artifact.local_path.clone(),
                        source,
                    };
                    queue.mark_retry(
                        &artifact.sha256,
                        &artifact.source_path,
                        &error.to_string(),
                    )?;
                    absent.insert(artifact.sha256.clone());
                    failed += 1;
                    continue;
                }
            };
            if sha256_bytes(&bytes) != artifact.sha256 {
                let error = DaemonError::Protocol(format!(
                    "queued blob {} failed SHA-256 verification",
                    artifact.sha256
                ));
                queue.mark_retry(&artifact.sha256, &artifact.source_path, &error.to_string())?;
                absent.insert(artifact.sha256.clone());
                failed += 1;
                continue;
            }
            if let Err(error) = self.transport.upload(artifact, bytes) {
                queue.mark_retry(&artifact.sha256, &artifact.source_path, &error.to_string())?;
                absent.insert(artifact.sha256.clone());
                failed += 1;
                continue;
            }
            uploaded += 1;
        }
        let batch_id = Uuid::now_v7().to_string();
        let manifest = IngestManifest {
            machine_id: machine_id.to_owned(),
            batch_id: batch_id.clone(),
            artifacts: artifacts
                .iter()
                .filter(|artifact| !absent.contains(&artifact.sha256))
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
        // Reconcile against what the manifest actually claimed, not against the
        // whole batch: an artifact the server refused is excluded from the
        // manifest on purpose, and counting it here turned a partial success
        // into a protocol error that failed the run.
        let claimed = manifest.artifacts.len() as u64;
        let receipt_total = receipt.accepted.saturating_add(receipt.duplicate);
        if receipt.batch_id != batch_id || receipt_total != claimed {
            let error = DaemonError::Protocol(format!(
                "manifest receipt mismatch: batch {} accepted {} duplicate {} for {} artifacts",
                receipt.batch_id, receipt.accepted, receipt.duplicate, claimed
            ));
            queue.mark_retry_all(&artifacts, &error.to_string())?;
            return Err(error);
        }
        // Only what the manifest claimed is synced; the rest stays queued. By
        // the whole primary key, because two rows can carry the same bytes from
        // two different places and only one of them was in this manifest.
        for artifact in artifacts
            .iter()
            .filter(|artifact| !absent.contains(&artifact.sha256))
        {
            queue.mark_synced(&artifact.sha256, &artifact.source_path)?;
        }
        Ok(SyncReport {
            failed,
            batch_id: Some(batch_id),
            considered: artifacts.len(),
            uploaded,
            duplicates,
        })
    }
}

/// What a capture pass did, including what it could not take.
///
/// A file that cannot be redacted is not uploaded — that is the fail-closed
/// promise and it holds. But it used to abort the whole pass, so one binary
/// file under a source directory meant nothing at all was archived, from any
/// source. It is skipped and counted now, and the count is reported, because a
/// file quietly dropped is its own kind of dishonesty.
#[derive(Debug, Default, Clone)]
pub struct CaptureSummary {
    pub captured: usize,
    pub skipped: Vec<PathBuf>,
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
    .map(|summary| summary.captured)
}

pub fn capture_sources_with_redaction(
    queue: &OfflineQueue,
    home: &Path,
    os: OperatingSystem,
    enabled_sources: &HashSet<String>,
    redaction: RedactionConfig,
) -> Result<CaptureSummary, DaemonError> {
    let mut summary = CaptureSummary::default();
    for spec in SOURCES {
        if !enabled_sources.is_empty() && !enabled_sources.contains(spec.id) {
            continue;
        }
        for path in files_for_source(spec, home, os)? {
            match queue.enqueue_with_redaction(spec.id, &path, redaction) {
                Ok(_) => summary.captured += 1,
                // The file stays on your machine. One of those must not cost
                // you everything else.
                Err(error) if error.is_skippable() => summary.skipped.push(path),
                Err(other) => return Err(other),
            }
        }
    }
    Ok(summary)
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
                    match queue.enqueue_with_redaction(spec.id, &path, redaction) {
                        Ok(_) => captured += 1,
                        // The same set the one-shot pass skips, named the same
                        // way. This branch listed two of the three refusals by
                        // hand, so `UnscannableSecret` fell through to the
                        // `return` below and a single non-UTF-8 file under
                        // ~/.claude/projects — a Zed write-ahead log, a Cursor
                        // state file, a transcript truncated mid-write — ended
                        // continuous capture for every source until the daemon
                        // was restarted, which would hit it again.
                        Err(error) if error.is_skippable() => {}
                        Err(other) => return Err(other),
                    }
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
        // Past the backoff a failed artifact now waits out, which is the point
        // of it being resumable rather than immediately retried.
        let pending = queue
            .pending_at(10, Utc::now() + chrono::Duration::hours(12))
            .unwrap();
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
        let pending = queue
            .pending_at(10, Utc::now() + chrono::Duration::hours(12))
            .unwrap();
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

    /// Assembled at runtime so the repository's own secret scan does not flag it.
    fn token_fixture() -> String {
        ["sk", "livefixtureabcdefghijklmnop"].join("_")
    }

    #[test]
    fn refuses_an_unscannable_artifact_that_still_shows_a_secret() {
        // Invalid UTF-8 means no pattern can be applied, so the artifact used
        // to be queued exactly as found while redaction was switched on. An
        // opaque database is refused for the same reason; this is the same
        // situation arriving through a different door.
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("capture.jsonl");
        let mut bytes = format!("token={} ", token_fixture()).into_bytes();
        bytes.extend_from_slice(&[0xff, 0xfe, 0x00]);
        fs::write(&source, &bytes).unwrap();

        let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
        let error = queue
            .enqueue_with_redaction(
                "fixture",
                &source,
                RedactionConfig {
                    secrets: true,
                    ..RedactionConfig::disabled()
                },
            )
            .expect_err("an unscannable artifact holding a secret must not be queued");
        assert!(
            matches!(error, DaemonError::UnscannableSecret { .. }),
            "expected an unscannable-secret refusal, got: {error}"
        );
        assert_eq!(queue.counts().unwrap().pending, 0, "nothing may be queued");
    }

    #[test]
    fn still_accepts_unscannable_bytes_that_hold_no_secret() {
        // Refusing every non-UTF-8 artifact would block ordinary captures, so
        // the refusal has to be about the secret, not about the encoding.
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("capture.bin");
        fs::write(&source, [0xff, 0xfe, 0x00, 0x41, 0x42]).unwrap();

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
            .expect("bytes with nothing to hide are still capturable");
        assert!(
            !artifact.redacted,
            "nothing was replaced, so nothing was redacted"
        );
        assert_eq!(artifact.redaction_count, 0);
    }

    #[test]
    fn reports_redaction_only_when_something_was_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("capture.jsonl");
        fs::write(&source, format!("token={}", token_fixture())).unwrap();
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
        assert!(artifact.redacted);
        assert!(artifact.redaction_count > 0);
        let stored = fs::read_to_string(&artifact.local_path).unwrap();
        assert!(
            !stored.contains(&token_fixture()),
            "the secret reached the queue"
        );
    }
    /// A transport that already holds some hashes and refuses others, which is
    /// what a real pass looks like once anything is large enough to lose.
    struct PartialTransport {
        present: HashSet<String>,
        refuse: HashSet<String>,
    }

    impl SyncTransport for PartialTransport {
        fn missing(
            &self,
            _machine_id: &str,
            hashes: &[String],
        ) -> Result<HashSet<String>, DaemonError> {
            Ok(hashes
                .iter()
                .filter(|hash| !self.present.contains(*hash))
                .cloned()
                .collect())
        }

        fn upload(&self, artifact: &QueuedArtifact, _bytes: Vec<u8>) -> Result<(), DaemonError> {
            if self.refuse.contains(&artifact.sha256) {
                return Err(DaemonError::Transport("connection closed".to_owned()));
            }
            Ok(())
        }

        fn submit_manifest(&self, manifest: &IngestManifest) -> Result<IngestReceipt, DaemonError> {
            Ok(IngestReceipt {
                batch_id: manifest.batch_id.clone(),
                accepted: manifest.artifacts.len() as u64,
                duplicate: 0,
                queued_at: Utc::now().to_rfc3339(),
            })
        }
    }

    /// A failed upload is not a duplicate.
    ///
    /// `duplicates` was `considered - uploaded`, so a pass that lost an upload
    /// reported it as bytes the archive already held — the one number that says
    /// "nothing to do here" standing in for the one that says "this never
    /// arrived".
    #[test]
    fn a_lost_upload_is_not_reported_as_a_duplicate() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let dir = home.join(".claude/projects/-workspace");
        fs::create_dir_all(&dir).unwrap();
        for (name, body) in [
            ("held.jsonl", "already in the archive"),
            ("lost.jsonl", "never arrives"),
            ("fresh.jsonl", "new capture"),
        ] {
            fs::write(dir.join(name), body).unwrap();
        }
        let queue = OfflineQueue::open(&temp.path().join("queue.sqlite3")).unwrap();
        let enabled = HashSet::from(["claude-code".to_owned()]);
        assert_eq!(
            capture_sources(&queue, &home, OperatingSystem::Linux, &enabled).unwrap(),
            3
        );

        let hash_of = |body: &str| sha256_bytes(body.as_bytes());
        let transport = PartialTransport {
            present: HashSet::from([hash_of("already in the archive")]),
            refuse: HashSet::from([hash_of("never arrives")]),
        };
        let report = SyncEngine::new(transport)
            .sync(&queue, "00000000-0000-4000-8000-000000000001")
            .unwrap();

        assert_eq!(report.considered, 3);
        assert_eq!(report.uploaded, 1, "only the fresh capture went up");
        assert_eq!(report.failed, 1, "the refused upload is a failure");
        assert_eq!(
            report.duplicates, 1,
            "only the hash the archive already held is a duplicate"
        );
        // The one that never arrived stays queued rather than being marked done.
        assert_eq!(queue.counts().unwrap().synced, 2);
    }
    /// The upload deadline has to be reachable for the largest artifact the
    /// archive will accept.
    ///
    /// reqwest's blocking client caps a whole request at 30 seconds by default,
    /// and `Client::new()` took that default. Every transcript over roughly
    /// 30 MB therefore failed on a deadline it could not meet, was requeued, and
    /// failed again — one 116 MB session reached twenty attempts having never
    /// once had the time to finish. This fails if the timeout drops or the size
    /// ceiling rises without the other moving too.
    #[test]
    fn the_upload_deadline_is_reachable_at_the_size_ceiling() {
        let needed = MAX_ARTIFACT_BYTES / SLOWEST_TOLERATED_UPLOAD_BYTES_PER_SEC;
        assert!(
            UPLOAD_TIMEOUT.as_secs() >= needed,
            "a {MAX_ARTIFACT_BYTES}-byte artifact needs {needed}s at the slowest \
             tolerated uplink, but uploads are cut off after {}s",
            UPLOAD_TIMEOUT.as_secs()
        );
        assert!(
            CONNECT_TIMEOUT < UPLOAD_TIMEOUT,
            "an unreachable host must fail long before a slow upload does"
        );
    }
}
