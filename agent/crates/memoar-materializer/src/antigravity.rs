//! Checking an Antigravity conversation database before it is written.
//!
//! The archive builds the database (`server/src/convert/antigravity-database.ts`).
//! This only confirms that what arrived is a sound SQLite file for this
//! conversation, so a corrupt download never lands where Antigravity would
//! open it.

use rusqlite::Connection;
use std::fs;
use uuid::Uuid;

use crate::error::MaterializeError;

pub(crate) fn validate_antigravity_database(
    bytes: &[u8],
    session_id: &str,
) -> Result<(), MaterializeError> {
    if !bytes.starts_with(b"SQLite format 3\0") {
        return Err(MaterializeError::Integrity(
            "Antigravity database is not SQLite".to_owned(),
        ));
    }
    let temp = std::env::temp_dir().join(format!("memoar-validate-{}.db", Uuid::now_v7()));
    let result = (|| -> Result<(), MaterializeError> {
        fs::write(&temp, bytes).map_err(|source| MaterializeError::Io {
            path: temp.clone(),
            source,
        })?;
        let connection = Connection::open(&temp)?;
        let integrity: String =
            connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(MaterializeError::Integrity(format!(
                "Antigravity SQLite integrity check returned {integrity}"
            )));
        }
        // Antigravity treats a database whose user_version is 0 as not yet
        // initialised and does not list the conversation.
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version < 1 {
            return Err(MaterializeError::Integrity(
                "Antigravity database is not initialised (user_version 0)".to_owned(),
            ));
        }
        let cascade: String = connection
            .query_row(
                "SELECT cascade_id FROM trajectory_meta LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| {
                MaterializeError::Integrity(format!(
                    "Antigravity database lacks trajectory_meta: {error}"
                ))
            })?;
        if cascade != session_id {
            return Err(MaterializeError::Integrity(format!(
                "Antigravity conversation {cascade} does not match session {session_id}"
            )));
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temp);
    result
}
