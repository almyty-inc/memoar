use memoar_connectors::{OperatingSystem, discover};
use memoar_daemon::{DaemonError, HttpTransport};
use serde_json::{Value, json};
use std::ffi::OsString;
use uuid::Uuid;

use crate::api::ApiClient;
use crate::config::{Config, RuntimePaths};
use crate::credential::Credential;
use crate::error::AppError;

pub(crate) fn patch_machine_state(
    api: &ApiClient,
    config: &Config,
    paths: &RuntimePaths,
) -> Result<(), AppError> {
    let source_settings = discover(&paths.home, OperatingSystem::current())
        .into_iter()
        .map(|source| {
            (
                source.id.to_owned(),
                json!({
                    "enabled": !config.disabled_sources.contains(source.id),
                    "detected": source.detected,
                    "tier": source.tier,
                    "stability": source.stability,
                    "paths": source.paths
                }),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    api.patch(
        &format!("/machines/{}", config.machine_id),
        &json!({
            "name": machine_name(),
            "agentVersion": env!("CARGO_PKG_VERSION"),
            "sourceSettings": source_settings
        }),
    )?;
    Ok(())
}

/// Whether this account still has the machine, separated from why it might not.
///
/// `login` has to tell "the archive does not know this machine" apart from "the
/// archive could not be reached": the first is a reason to enrol afresh, the
/// second is a reason to stop. Folding both into one error made that
/// undecidable, so the lookup reports absence and leaves failure to propagate.
pub(crate) fn machine_exists(api: &ApiClient, machine_id: &str) -> Result<bool, AppError> {
    let machines = api.get("/machines")?;
    Ok(machines
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|machine| machine.get("id").and_then(Value::as_str) == Some(machine_id))
        }))
}

pub(crate) fn verify_machine(api: &ApiClient, machine_id: &str) -> Result<(), AppError> {
    if !machine_exists(api, machine_id)? {
        return Err(AppError::network(format!(
            "machine {machine_id} is not registered for this credential"
        )));
    }
    Ok(())
}

/// A transport that can replace its own machine token.
///
/// The machine token lives fifteen minutes; a single upload is allowed half an
/// hour. Minting once per batch therefore handed long uploads a credential that
/// had already expired by the time the server read it, and the archive answered
/// 401 after accepting every byte. The transport now mints again whenever the
/// token it holds is close to death, using the account credential — which,
/// since `login` stores an API key, does not itself expire.
pub(crate) fn capture_transport(
    config: &Config,
    credential: &Credential,
    token: &str,
    expires_at: Option<&str>,
) -> HttpTransport {
    let endpoint = config.endpoint.clone();
    let machine_id = config.machine_id.clone();
    let credential = credential.clone();
    HttpTransport::with_minter(
        &config.endpoint,
        token,
        expires_at,
        Some(Box::new(move || {
            let api = ApiClient::new(&endpoint, Some(&credential));
            issue_machine_token(&api, &machine_id)
                .map_err(|error| DaemonError::Transport(error.message.clone()))
        })),
    )
}

/// Mints a machine token, and reports when it dies.
///
/// The expiry is not decoration: it is what lets the transport replace the token
/// before a long upload starts rather than after one has failed.
pub(crate) fn issue_machine_token(
    api: &ApiClient,
    machine_id: &str,
) -> Result<(String, Option<String>), AppError> {
    let response = api.post("/auth/machine-token", &json!({ "machineId": machine_id }))?;
    let token = response
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| AppError::network("machine token response did not include token"))?
        .to_owned();
    let expires_at = response
        .get("expiresAt")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok((token, expires_at))
}

pub(crate) fn validate_uuid_v7(label: &str, value: &str) -> Result<(), AppError> {
    let id = Uuid::parse_str(value)
        .map_err(|error| AppError::network(format!("invalid {label}: {error}")))?;
    if id.get_version_num() != 7 {
        return Err(AppError::network(format!("{label} is not UUIDv7")));
    }
    Ok(())
}

/// What this computer is called in the machine list.
///
/// `HOSTNAME` is a shell variable, not an exported one: a process spawned from
/// bash almost never sees it, and `COMPUTERNAME` exists only on Windows. So the
/// old two-variable lookup fell through to the literal `memoar-machine` on
/// essentially every Unix machine, and an account's machine list read as several
/// rows all called the same thing. Asking the system for its hostname is what
/// the variables were standing in for; they still win where they are set, so
/// exporting one deliberately keeps working.
///
/// This is a label and nothing more. Nothing identifies a machine by it — see
/// `Config::installation_id` — precisely because hostnames are neither unique
/// nor stable.
pub(crate) fn machine_name() -> String {
    resolve_machine_name(
        std::env::var_os("HOSTNAME"),
        std::env::var_os("COMPUTERNAME"),
        system_hostname,
    )
}

/// Takes the values rather than reading the environment, because a test that
/// sets process-wide environment variables races every other test in the binary.
/// `system` is lazy so the fallback costs nothing when a variable is set.
pub(crate) fn resolve_machine_name(
    hostname: Option<OsString>,
    computer_name: Option<OsString>,
    system: impl FnOnce() -> Option<String>,
) -> String {
    let usable = |value: OsString| {
        value
            .to_str()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    hostname
        .and_then(usable)
        .or_else(|| computer_name.and_then(usable))
        .or_else(system)
        .unwrap_or_else(|| "memoar-machine".to_owned())
}

/// The hostname as the operating system reports it, or nothing.
///
/// `hostname` is present on macOS, Linux and Windows. A name is decoration, so
/// every way this can fail — no such binary, a non-zero exit, bytes that are not
/// UTF-8 — is answered with "no name", never an error that would stop a login.
fn system_hostname() -> Option<String> {
    let output = std::process::Command::new("hostname").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!name.is_empty()).then_some(name)
}
