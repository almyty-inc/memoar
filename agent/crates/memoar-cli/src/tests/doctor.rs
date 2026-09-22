//! What `doctor` is allowed to claim.
//!
//! Every test here is about the same rule: a check may say `true` only if it
//! measured something and the something was fine.

use serde_json::{Value, json};

use crate::doctor::doctor;
use crate::tests::mock::{configured_paths, spawn_mock_api};

fn named<'a>(report: &'a Value, name: &str) -> &'a Value {
    report["checks"]
        .as_array()
        .expect("checks")
        .iter()
        .find(|check| check["name"] == name)
        .unwrap_or_else(|| panic!("doctor must report a {name} check: {report}"))
}

/// An archive that cannot answer must not have its answer invented.
///
/// `artifacts_parsed` asked `/ingest/unparsed` and, on any failure to ask,
/// reported `ok: true` with "everything uploaded became a session" — a claim
/// about the archive's contents made with no word from the archive. An archive
/// too old to serve the endpoint, or behind a proxy that 502s it, certified
/// itself as having parsed everything.
///
/// The mock answers the three machine calls and then stops accepting, which is
/// what an archive without this endpoint looks like from here.
#[test]
fn an_archive_that_did_not_answer_does_not_get_a_green_check() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, _requests, server) = spawn_mock_api(3, None);
    let paths = configured_paths(&temp, &endpoint);

    let report = doctor(&paths)
        .expect("doctor reports, it does not abort")
        .data;
    server.join().unwrap();

    let parsed = named(&report, "artifacts_parsed");
    assert_eq!(
        parsed["ok"],
        Value::Null,
        "unmeasured is not passing: {parsed}"
    );
    assert!(
        !parsed["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("everything uploaded became a session"),
        "the archive said nothing, so doctor must not say this: {parsed}"
    );
    assert!(
        parsed["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("/ingest/unparsed"),
        "and must name what it could not ask: {parsed}"
    );
    assert_eq!(report["ok"], json!(false), "a null check is not a pass");
}

/// `doctor` on a machine that cannot reach its archive.
///
/// The network calls ran ahead of the check list with `?`, so the command
/// whose whole job is telling the truth about a broken machine printed one
/// transport error, exited 4, and said nothing about the queue, the
/// credentials, the contract version or a symlinked session store — every one
/// of which it can answer with no network at all. Meanwhile `api_reachable`
/// and `machine_registered` were the literal `true` in the report they never
/// reached.
#[test]
fn an_unreachable_archive_still_produces_the_local_checks() {
    let temp = tempfile::tempdir().unwrap();
    // Port 1 on loopback: nothing listens, and the connection is refused
    // immediately rather than hanging.
    let paths = configured_paths(&temp, "http://127.0.0.1:1/v1");

    let report = doctor(&paths)
        .expect("an unreachable archive is a finding, not a reason to report nothing")
        .data;

    assert_eq!(named(&report, "queue_integrity")["ok"], json!(true));
    assert_eq!(named(&report, "credentials")["ok"], json!(true));
    assert_eq!(named(&report, "contract_version")["ok"], json!(true));
    assert_eq!(named(&report, "source_symlinks")["ok"], json!(true));

    let reachable = named(&report, "api_reachable");
    assert_eq!(
        reachable["ok"],
        json!(false),
        "this check must be able to be false: {reachable}"
    );
    assert!(
        reachable["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("127.0.0.1:1"),
        "and must name the endpoint it could not reach: {reachable}"
    );
    assert_eq!(
        named(&report, "machine_registered")["ok"],
        Value::Null,
        "the archive was not asked, so this is unknown, not registered"
    );
    assert_eq!(named(&report, "machine_token")["ok"], Value::Null);
    assert_eq!(report["ok"], json!(false));
}

/// A queue that will not open is the condition `doctor` is run to find.
///
/// Opening it was a `?` at the top of the command, so the one check that would
/// have named the problem was the check that suppressed every other one.
#[test]
fn a_broken_queue_is_reported_rather_than_aborting_the_report() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:1/v1");
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    // A directory where the database belongs: SQLite cannot open it, and it is
    // what a half-restored backup or a stale mount actually looks like.
    std::fs::create_dir_all(paths.queue_file()).unwrap();

    let report = doctor(&paths)
        .expect("doctor must survive its own queue")
        .data;

    let queue = named(&report, "queue_integrity");
    assert_eq!(queue["ok"], json!(false), "{queue}");
    assert!(
        queue["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("queue.sqlite3"),
        "the check must name the file: {queue}"
    );
    assert_eq!(
        named(&report, "credentials")["ok"],
        json!(true),
        "the other checks still ran"
    );
}
