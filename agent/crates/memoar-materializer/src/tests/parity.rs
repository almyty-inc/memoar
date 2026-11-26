//! The machine half of the session-conversion agreement.
//!
//! `server/test/conversion-bundle-parity.test.ts` holds the archive to the same
//! file. Between them, neither half can change what it builds or what it
//! accepts without the other failing.

use rusqlite::Connection;

use crate::bundle::ConversionBundle;
use crate::entry::materialize_bundle;

/// The archive's own bundle, written to a disk by the code that writes disks.
///
/// The archive once built this database with tables of its own invention while
/// `validate_antigravity_database` looked for `trajectory_meta`, and later put
/// it under `brain/<id>/`, where Antigravity does not look for conversations.
/// Neither half could see either mistake alone.
#[test]
fn materializes_the_committed_server_bundle() {
    let temp = tempfile::tempdir().unwrap();
    let bundle: ConversionBundle = serde_json::from_str(include_str!(
        "../../../../../contracts/fixtures/session-conversion-bundle.json"
    ))
    .expect("the committed bundle must parse as one");

    let result = materialize_bundle(&bundle, temp.path())
        .expect("the archive's own bundle must be one this crate will write");

    let database = temp
        .path()
        .join(".gemini/antigravity-cli/conversations")
        .join(format!("{}.db", bundle.session_id));
    assert_eq!(result.written, vec![database.clone()]);
    let connection = Connection::open(&database).unwrap();
    let steps: i64 = connection
        .query_row("SELECT count(*) FROM steps", [], |row| row.get(0))
        .unwrap();
    assert!(steps >= 2, "the database is what carries the conversation");
}
