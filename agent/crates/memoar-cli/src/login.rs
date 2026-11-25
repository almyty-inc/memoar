use memoar_daemon::{OfflineQueue, RedactionConfig};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::CommandOutput;
use crate::account::{sign_in, validated_endpoint};
use crate::api::ApiClient;
use crate::args::LoginArgs;
use crate::config::{Config, RuntimePaths, load_config_optional, save_config};
use crate::credential::{CAPTURE_SCOPES, Credential, CredentialStore};
use crate::error::{AppError, map_queue_error};
use crate::machine::{
    machine_exists, machine_name, patch_machine_state, validate_uuid_v7, verify_machine,
};
use crate::revoke::{MINTED_KEY_NAME, revocation_report, revoke_key};

pub(crate) fn login(args: &LoginArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let endpoint = validated_endpoint(&args.endpoint)?;
    let endpoint = endpoint.as_str();
    // What the user handed us, or what a password buys: either way it is only
    // good enough to register the machine and mint the credential that lasts.
    let account = sign_in(
        endpoint,
        args.email.as_deref(),
        args.password.as_deref(),
        args.token.as_deref(),
        "login",
    )?;
    let api = ApiClient::new(endpoint, Some(&account));
    // A config this cannot read must not stop the login that rewrites it:
    // refusing here left `login`, the one command that fixes it, broken too.
    let existing = load_config_optional(paths).ok().flatten();
    let kept = existing
        .as_ref()
        .map(|config| config.redaction)
        .unwrap_or_else(RedactionConfig::disabled);
    // One installation, one identity, for the life of this config directory.
    let installation_id = existing
        .as_ref()
        .map(|config| config.installation_id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| Uuid::now_v7().to_string());
    let Enrolment {
        machine_id,
        registered,
    } = resolve_machine(&api, args, existing.as_ref(), &installation_id)?;
    validate_uuid_v7("machine id", &machine_id)?;
    let config = Config {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        endpoint: endpoint.to_owned(),
        machine_id: machine_id.clone(),
        installation_id,
        // What this computer was already set to keep. A re-login used to
        // reset both: every source turned off came back on, and redaction
        // chosen with `memoar redaction` was switched off by a login run
        // without the flags. A flag can turn a mask on here, and only
        // `memoar redaction` turns one off.
        disabled_sources: existing
            .as_ref()
            .map(|config| config.disabled_sources.clone())
            .unwrap_or_default(),
        redaction: RedactionConfig {
            secrets: args.redact_secrets || kept.secrets,
            email_addresses: args.redact_email_addresses || kept.email_addresses,
            home_paths: args.redact_home_paths || kept.home_paths,
        },
    };
    patch_machine_state(&api, &config, paths)?;
    // A password or a browser token gets us this far and no further: what is
    // stored is a capture-scoped key that does not expire, so no later command
    // depends on a credential with an hour to live.
    // The key a previous `login` left here, read before it is overwritten. A
    // damaged file is not a reason to refuse a login that will replace it.
    let store = paths.credential_store();
    let previous = match store.load() {
        Ok(Some(Credential::ApiKey(secret))) => Some((secret, store.key_id())),
        _ => None,
    };
    let (credential, key_id) = match &account {
        Credential::ApiKey(_) => (account.clone(), None),
        Credential::Bearer(_) => mint_capture_key(&api, &machine_name())?,
    };
    match (&credential, &key_id) {
        (Credential::ApiKey(secret), Some(id)) => store.store_minted(secret, Some(id))?,
        _ => store.store(&credential)?,
    }
    save_config(paths, &config)?;
    OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    // Only once the new key is safely stored, and only with the password
    // session, which is what holds `keys:write`. Every `login` used to leave
    // the key before it live on the server.
    let previous_key = previous
        .filter(|(secret, _)| Some(secret.as_str()) != Some(credential.secret()))
        .filter(|_| matches!(account, Credential::Bearer(_)))
        .map(|(secret, id)| revocation_report(revoke_key(&api, &secret, id.as_deref())));
    Ok(CommandOutput {
        command: "login".to_owned(),
        data: json!({
            "initialized": true,
            "endpoint": config.endpoint,
            "machineId": machine_id,
            // Registering is the noteworthy outcome, not the ordinary one: a
            // re-login that quietly enrols a second machine is the bug this
            // field exists to make visible.
            "machineRegistered": registered,
            "credential": match credential { Credential::ApiKey(_) => "api-key", Credential::Bearer(_) => "access-token" },
            "redaction": config.redaction,
            // The key the last `login` stored, revoked now that this one
            // replaces it. Absent when there was none to revoke.
            "previousKey": previous_key
        }),
    })
}

struct Enrolment {
    machine_id: String,
    /// False when `login` reused the machine this computer already had.
    registered: bool,
}

/// Which machine this computer is, on a `login` that may not be its first.
///
/// `login` used to `POST /machines` unconditionally, so every re-login — to
/// change the endpoint, to re-authenticate, after a credential expired — minted
/// another machine. A memory document is unique on (tenant, machine, path), so
/// each extra machine duplicated every instruction file the agent captured; one
/// account reached five machine records for one laptop, and 346 documents over
/// 173 paths.
///
/// The order is deliberate. `--machine-id` is an explicit instruction and wins.
/// Otherwise the machine already named in `config.json` is reused, but only
/// after the archive confirms it still has it — which also settles the case of a
/// config pointing at a different archive, since that archive will not list an
/// id it never issued. Only a machine the archive genuinely does not have leads
/// to a fresh registration.
fn resolve_machine(
    api: &ApiClient,
    args: &LoginArgs,
    existing: Option<&Config>,
    installation_id: &str,
) -> Result<Enrolment, AppError> {
    if let Some(machine_id) = &args.machine_id {
        verify_machine(api, machine_id)?;
        return Ok(Enrolment {
            machine_id: machine_id.clone(),
            registered: false,
        });
    }
    // A config written before this field existed, or hand-edited into nonsense,
    // is not a reason to refuse to log in — it is a reason to enrol afresh.
    let stored = existing
        .map(|config| config.machine_id.trim())
        .filter(|machine_id| validate_uuid_v7("machine id", machine_id).is_ok());
    if let Some(machine_id) = stored
        && machine_exists(api, machine_id)?
    {
        return Ok(Enrolment {
            machine_id: machine_id.to_owned(),
            registered: false,
        });
    }
    // Gone from the account, or never this account's: enrol. The alternative —
    // failing and telling the operator to edit config.json — turns deleting a
    // machine in the web app into a laptop that can no longer log in.
    let machine = api.post(
        "/machines",
        &json!({
            "name": machine_name(),
            "platform": std::env::consts::OS,
            "agentVersion": env!("CARGO_PKG_VERSION"),
            "installationId": installation_id
        }),
    )?;
    Ok(Enrolment {
        machine_id: machine
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::network("machine registration response did not include id"))?
            .to_owned(),
        registered: true,
    })
}

/// Trades the account credential for a long-lived one scoped to capture.
///
/// This is the whole point of the change. `login` used to keep the browser
/// access token, which the server issues for one hour with no refresh, so every
/// later command was living on a credential that had usually already died —
/// `sync --watch`, whose entire job is to keep running, could not survive its
/// own first hour.
///
/// Named after the machine so a key is recognisable in the account's key list
/// and can be revoked for one laptop without touching the others.
fn mint_capture_key(
    api: &ApiClient,
    machine_name: &str,
) -> Result<(Credential, Option<String>), AppError> {
    let response = api.post(
        "/auth/api-keys",
        &json!({ "name": format!("{MINTED_KEY_NAME} · {machine_name}"), "scopes": CAPTURE_SCOPES }),
    )?;
    let secret = response
        .get("secret")
        .and_then(Value::as_str)
        .filter(|secret| !secret.is_empty())
        .ok_or_else(|| AppError::network("API key response did not include secret"))?;
    let id = response
        .pointer("/apiKey/id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok((Credential::classify(secret), id))
}
