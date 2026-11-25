//! The queue table: its rows, its schema, and the migrations onto it.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::DaemonError;
use crate::space::{SpaceCheck, SpaceFloor, ensure_space};

/// 4 stopped copying every artifact: a row names its source file and a blob
/// only when the bytes to upload differ from the source.
const SCHEMA_VERSION: i64 = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueStatus {
    Pending,
    Retry,
    Synced,
    /// Queued once, and outside the capture policy now: older than the
    /// backfill window or in an excluded project. Not offered for upload until
    /// the policy takes it in again.
    Held,
}

impl QueueStatus {
    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "synced" => Self::Synced,
            "retry" => Self::Retry,
            "held" => Self::Held,
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
    /// A private copy of the bytes to upload, kept only when the source cannot
    /// stand in for them: redacted content, or a database the tool rewrites in
    /// place. `None` means the upload reads the source file and checks it
    /// still hashes to `sha256`.
    pub local_path: Option<PathBuf>,
    pub modified_at: String,
    pub status: QueueStatus,
    pub attempts: u32,
    pub last_error: Option<String>,
    pub redacted: bool,
    pub redaction_count: u32,
}

impl QueuedArtifact {
    /// Where the bytes to upload are read from.
    #[must_use]
    pub fn content_path(&self) -> &Path {
        self.local_path
            .as_deref()
            .unwrap_or_else(|| Path::new(&self.source_path))
    }
}

/// A stored `local_path`. The column predates optional blobs and is NOT NULL,
/// so an empty string stands for "read the source".
pub(crate) fn blob_path(value: String) -> Option<PathBuf> {
    (!value.is_empty()).then(|| PathBuf::from(value))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCounts {
    pub pending: u64,
    pub retry: u64,
    pub synced: u64,
    /// Queued and outside the capture policy, so not being uploaded.
    pub held: u64,
}

pub struct OfflineQueue {
    pub(crate) connection: Connection,
    pub(crate) blob_dir: PathBuf,
    /// The free-space floor blob writes respect. `None` writes without asking,
    /// which is what a test on a nearly full CI runner needs.
    pub(crate) space_floor: Option<SpaceFloor>,
}

impl OfflineQueue {
    pub fn open(path: &Path) -> Result<Self, DaemonError> {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        create_private_dir(parent)?;
        let blob_dir = parent.join("blobs");
        create_private_dir(&blob_dir)?;
        // The blobs are the captured transcripts themselves, and the queue
        // used to keep them in a directory every user on the machine could
        // list and read. A directory made by an older agent is tightened.
        restrict_to_owner(&blob_dir)?;
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
        // Schema 4. The size of the source file and the redaction settings it
        // was read under, so an unchanged file is recognised from a `stat`
        // without reading it again, and the workspace it belongs to, so the
        // capture policy can be applied to rows already queued.
        ensure_column(&connection, "artifacts", "source_size", "INTEGER")?;
        ensure_column(&connection, "artifacts", "redaction_key", "TEXT")?;
        ensure_column(&connection, "artifacts", "workspace", "TEXT")?;
        connection.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_artifacts_source ON artifacts(source_path, modified_at);
             CREATE INDEX IF NOT EXISTS idx_artifacts_local ON artifacts(local_path);",
        )?;
        connection.execute(
            "INSERT INTO metadata(key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
        Ok(Self {
            connection,
            blob_dir,
            space_floor: None,
        })
    }

    /// Refuse blob writes that would take the volume below `floor`.
    #[must_use]
    pub fn with_space_floor(mut self, floor: SpaceFloor) -> Self {
        self.space_floor = Some(floor);
        self
    }

    /// The queue's volume measured against its floor, as a refusal when it
    /// would fall below it with `needed` more bytes written. A queue with no
    /// floor always passes.
    pub fn ensure_space(&self, needed: u64) -> Result<Option<SpaceCheck>, DaemonError> {
        match self.space_floor {
            Some(floor) => ensure_space(&self.blob_dir, floor, needed).map(Some),
            None => Ok(None),
        }
    }

    pub(crate) fn metadata(&self, key: &str) -> Result<Option<String>, DaemonError> {
        use rusqlite::OptionalExtension;
        self.connection
            .query_row("SELECT value FROM metadata WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(Into::into)
    }

    pub(crate) fn set_metadata(&self, key: &str, value: &str) -> Result<(), DaemonError> {
        self.connection.execute(
            "INSERT INTO metadata(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    /// Runs `work` in one transaction. With `synchronous = FULL` every bare
    /// statement is its own fsync, and a first capture of a few hundred
    /// thousand files spent its time waiting on the disk, not reading files.
    pub(crate) fn batch<R>(
        &self,
        work: impl FnOnce() -> Result<R, DaemonError>,
    ) -> Result<R, DaemonError> {
        self.connection.execute_batch("BEGIN IMMEDIATE")?;
        match work() {
            Ok(value) => {
                self.connection.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.connection.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
}

/// Creates a directory, and any parent it needs, readable by its owner only.
///
/// On Windows a new directory inherits the ACL of the profile it sits in,
/// which already admits only the user, so there is nothing to add.
fn create_private_dir(path: &Path) -> Result<(), DaemonError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|source| DaemonError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> Result<(), DaemonError> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::metadata(path).map_err(|source| DaemonError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.permissions().mode() & 0o077 == 0 {
        return Ok(());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| DaemonError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> Result<(), DaemonError> {
    Ok(())
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
