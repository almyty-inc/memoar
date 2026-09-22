//! `memoar doctor` — what is actually wrong with this machine.
//!
//! The rule the whole command is built on: a check may report `true` only if
//! it measured the thing and the thing was fine. It had two ways of breaking
//! that rule, and both made `doctor` useless in exactly the situation it
//! exists for.
//!
//! The first: `api_reachable` and `machine_registered` were the literal
//! `true`. They could not be false, because the requests that would have
//! settled them ran ahead of the check list with `?`, so an archive that could
//! not be reached did not produce a red check — it produced no report at all.
//! `memoar doctor` on an offline laptop printed one transport error and exit
//! 4, and said nothing about the queue, the credentials, the contract version
//! or a symlinked session store, every one of which it could have answered
//! without a network.
//!
//! The second: `artifacts_parsed` asked the archive and, on any failure to
//! ask, reported `ok: true` with "everything uploaded became a session" — a
//! positive claim about the archive's contents, made without an answer from
//! the archive.
//!
//! So: nothing aborts the report, and a check that could not be run is `null`,
//! which is neither pass nor fail and is not counted as a pass.

use memoar_connectors::SOURCES;
use memoar_daemon::OfflineQueue;
use serde_json::{Value, json};

use crate::CommandOutput;
use crate::api::ApiClient;
use crate::config::{RuntimePaths, load_config, load_credential};
use crate::error::AppError;
use crate::machine::{issue_machine_token, machine_exists, patch_machine_state};
use crate::status::{skipped_symlinks, symlink_summary};

/// One check's verdict.
///
/// `ok` is three-valued on purpose. `null` is "this could not be measured",
/// which is the answer a dark archive deserves and is not the same as passing.
fn check(name: &str, ok: Option<bool>, detail: impl Into<String>) -> Value {
    json!({ "name": name, "ok": ok, "detail": detail.into() })
}

/// Whether the archive answered at all.
///
/// A transport failure and a refusal both arrive as `AppError::network`, and
/// they are different diagnoses: one is "this machine cannot reach the
/// archive", the other is "the archive is there and said no". The refusal
/// carries its status, which is how the two are told apart — the same cue
/// `sync --watch` uses to decide a credential is dead rather than the network.
fn archive_answered(message: &str) -> bool {
    message.contains("(HTTP ")
}

fn refused_credentials(message: &str) -> bool {
    message.ends_with("(HTTP 401)") || message.ends_with("(HTTP 403)")
}

pub(crate) fn doctor(paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    // Config and credentials are the only two things still fatal: without them
    // there is no endpoint to probe and no machine id to ask about, and
    // `not_initialized` already says exactly what to run.
    let config = load_config(paths)?;
    let credential = load_credential(paths)?;
    let mut checks = vec![
        check(
            "contract_version",
            Some(config.contract_version == memoar_canonical::CONTRACT_VERSION),
            format!(
                "config says {}, this client speaks {}",
                config.contract_version,
                memoar_canonical::CONTRACT_VERSION
            ),
        ),
        queue_check(paths),
        check(
            "credentials",
            Some(!credential.secret().is_empty()),
            "credential store contains a token",
        ),
        check(
            "source_table",
            Some(!SOURCES.is_empty()),
            format!("{} sources", SOURCES.len()),
        ),
    ];

    let symlinks = skipped_symlinks(&paths.home);
    // A source can be detected and still be captured from not at all: a
    // symlinked store is skipped by discovery in silence. Not ok — files this
    // machine believes it is archiving are being dropped.
    let mut symlink_check = check(
        "source_symlinks",
        Some(symlinks.is_empty()),
        if symlinks.is_empty() {
            "no source is behind a symlink".to_owned()
        } else {
            format!("{} skipped: {}", symlinks.len(), symlink_summary(&symlinks))
        },
    );
    symlink_check["skipped"] = json!(symlinks);
    checks.push(symlink_check);

    let api = ApiClient::new(&config.endpoint, Some(&credential));
    checks.extend(archive_checks(&api, &config.endpoint, &config.machine_id));
    checks.push(machine_state_check(&api, &config, paths));
    checks.push(unparsed_check(&api));

    // Only a measured pass counts as a pass. `null` — could not be checked —
    // fails the total, because "I could not tell you" is not "you are fine",
    // and `doctor` is run by somebody who already suspects it is not.
    let ok = checks.iter().all(|check| check["ok"] == json!(true));
    Ok(CommandOutput {
        command: "doctor".to_owned(),
        data: json!({ "ok": ok, "checks": checks }),
    })
}

/// The offline queue, opened and integrity-checked without ending the report.
///
/// A queue that will not open is precisely the condition `doctor` is run to
/// find. It used to abort the command, so the one check that would have named
/// the problem was the check that suppressed every other.
fn queue_check(paths: &RuntimePaths) -> Value {
    let path = paths.queue_file().display().to_string();
    match OfflineQueue::open(&paths.queue_file()).and_then(|queue| queue.integrity_check()) {
        Ok(true) => check("queue_integrity", Some(true), path),
        Ok(false) => check(
            "queue_integrity",
            Some(false),
            format!("{path} failed its integrity check"),
        ),
        Err(error) => check(
            "queue_integrity",
            Some(false),
            format!("{path} could not be opened: {error}"),
        ),
    }
}

/// The three things only the archive can answer, from one round trip each and
/// none of them fatal.
fn archive_checks(api: &ApiClient, endpoint: &str, machine_id: &str) -> Vec<Value> {
    let registration = machine_exists(api, machine_id);
    let failure = registration
        .as_ref()
        .err()
        .map(|error| error.message.clone());
    let reachable = match &failure {
        None => Some(true),
        Some(message) => Some(archive_answered(message)),
    };
    let mut checks = vec![check(
        "api_reachable",
        reachable,
        match &failure {
            None => endpoint.to_owned(),
            Some(message) => format!("{endpoint}: {message}"),
        },
    )];
    // Whether the archive accepts what is in the credential store, rather than
    // whether the store has bytes in it. A revoked key passes the file check
    // and fails this one, which is the whole difference between testing the
    // config and testing what the config describes.
    checks.push(check(
        "credentials_accepted",
        match &failure {
            None => Some(true),
            Some(message) if refused_credentials(message) => Some(false),
            Some(_) => None,
        },
        match &failure {
            Some(message) if refused_credentials(message) => message.clone(),
            Some(_) => "the archive could not be reached, so this was not checked".to_owned(),
            None => "the archive accepted this machine's credential".to_owned(),
        },
    ));
    checks.push(match &registration {
        Ok(true) => check("machine_registered", Some(true), machine_id.to_owned()),
        Ok(false) => check(
            "machine_registered",
            Some(false),
            format!("the archive does not list machine {machine_id}; run `memoar login`"),
        ),
        Err(error) => check(
            "machine_registered",
            None,
            format!("could not be checked: {}", error.message),
        ),
    });
    checks.push(match issue_machine_token(api, machine_id) {
        Ok((token, _)) => check(
            "machine_token",
            Some(!token.is_empty()),
            "machine token issued",
        ),
        // The archive refusing to mint a token is a real red: this machine
        // cannot upload. The archive being unreachable is not a verdict on the
        // token at all, and saying so is more use than a red that only repeats
        // the line above it.
        Err(error) if archive_answered(&error.message) => check(
            "machine_token",
            Some(false),
            format!("the archive refused a machine token: {}", error.message),
        ),
        Err(error) => check(
            "machine_token",
            None,
            format!("could not be checked: {}", error.message),
        ),
    });
    checks
}

/// Publishing this machine's source settings is a write, and it used to be a
/// `?` in the middle of `doctor`: an archive that refused it produced no report
/// at all. It is reported as what it is instead.
fn machine_state_check(
    api: &ApiClient,
    config: &crate::config::Config,
    paths: &RuntimePaths,
) -> Value {
    match patch_machine_state(api, config, paths) {
        Ok(()) => check(
            "machine_state_published",
            Some(true),
            "this machine's source settings are current in the archive",
        ),
        Err(error) => check("machine_state_published", Some(false), error.message),
    }
}

/// Bytes the archive kept and could not read.
///
/// Keeping them is the right thing — a parser written later can still use them
/// — but a tool that produces only these is capturing the wrong files, which is
/// the one way capture fails without failing.
///
/// An archive that cannot answer leaves this `null`. It used to leave it green,
/// with the sentence "everything uploaded became a session" — a claim about
/// what the archive holds, printed without the archive having said a word. An
/// archive too old to serve `/ingest/unparsed` therefore certified itself.
fn unparsed_check(api: &ApiClient) -> Value {
    let items = match api.get("/ingest/unparsed") {
        Ok(body) => body,
        Err(error) => {
            return check(
                "artifacts_parsed",
                None,
                format!(
                    "the archive did not answer /ingest/unparsed: {}",
                    error.message
                ),
            );
        }
    };
    let unparsed: Vec<(String, u64)> = items
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some((
                        item.get("source")?.as_str()?.to_owned(),
                        item.get("artifacts")?.as_u64()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut result = check(
        "artifacts_parsed",
        Some(unparsed.is_empty()),
        if unparsed.is_empty() {
            "everything uploaded became a session".to_owned()
        } else {
            unparsed
                .iter()
                .map(|(source, count)| format!("{source}: {count}"))
                .collect::<Vec<_>>()
                .join(", ")
        },
    );
    result["unparsed"] = json!(
        unparsed
            .iter()
            .map(|(source, count)| json!({ "source": source, "artifacts": count }))
            .collect::<Vec<_>>()
    );
    result
}
