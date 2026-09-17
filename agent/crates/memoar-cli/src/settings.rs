use memoar_connectors::{OperatingSystem, SOURCES, discover};
use serde_json::json;

use crate::CommandOutput;
use crate::api::ApiClient;
use crate::args::{RedactionArgs, SourcesCommand};
use crate::config::{
    RuntimePaths, load_config, load_config_optional, load_credential, save_config,
};
use crate::error::AppError;
use crate::machine::patch_machine_state;

pub(crate) fn sources(
    command: &SourcesCommand,
    paths: &RuntimePaths,
) -> Result<CommandOutput, AppError> {
    match command {
        SourcesCommand::List => {
            let config = load_config_optional(paths)?;
            let disabled = config
                .as_ref()
                .map(|config| &config.disabled_sources)
                .cloned()
                .unwrap_or_default();
            let items: Vec<_> = discover(&paths.home, OperatingSystem::current())
                .into_iter()
                .map(|source| {
                    json!({
                        "id": source.id,
                        "displayName": source.display_name,
                        "tier": source.tier,
                        "format": source.format,
                        "stability": source.stability,
                        "paths": source.paths,
                        "detected": source.detected,
                        "enabled": !disabled.contains(source.id)
                    })
                })
                .collect();
            Ok(CommandOutput {
                command: "sources.list".to_owned(),
                data: json!({ "items": items }),
            })
        }
        SourcesCommand::Enable { source } => update_source(paths, source, true),
        SourcesCommand::Disable { source } => update_source(paths, source, false),
    }
}

fn update_source(
    paths: &RuntimePaths,
    source: &str,
    enabled: bool,
) -> Result<CommandOutput, AppError> {
    if !SOURCES.iter().any(|item| item.id == source) {
        return Err(AppError::usage(format!("unknown source: {source}")));
    }
    let mut config = load_config(paths)?;
    if enabled {
        config.disabled_sources.remove(source);
    } else {
        config.disabled_sources.insert(source.to_owned());
    }
    save_config(paths, &config)?;
    let token = load_credential(paths)?;
    patch_machine_state(
        &ApiClient::new(&config.endpoint, Some(&token)),
        &config,
        paths,
    )?;
    Ok(CommandOutput {
        command: if enabled {
            "sources.enable"
        } else {
            "sources.disable"
        }
        .to_owned(),
        data: json!({ "source": source, "enabled": enabled }),
    })
}

/// Reads, and changes, what is masked before upload.
///
/// `login` was the only place redaction was ever written. Somebody who forgot
/// the flags had to delete their configuration and sign in again to add them,
/// and the desktop app — the path somebody who does not use a terminal takes —
/// passed all three as false with nothing anywhere to change them. A setting
/// that can only be chosen once, before you have seen what gets uploaded, is
/// not a setting.
///
/// Deliberately local and offline: turning masking on is exactly what somebody
/// does after noticing something they did not want sent, and that must not
/// depend on the archive being reachable. It applies from the next capture;
/// what has already been uploaded is already uploaded.
pub(crate) fn redaction(
    args: &RedactionArgs,
    paths: &RuntimePaths,
) -> Result<CommandOutput, AppError> {
    let mut config = load_config(paths)?;
    let before = config.redaction;
    if let Some(secrets) = args.secrets {
        config.redaction.secrets = secrets;
    }
    if let Some(email_addresses) = args.email_addresses {
        config.redaction.email_addresses = email_addresses;
    }
    if let Some(home_paths) = args.home_paths {
        config.redaction.home_paths = home_paths;
    }
    // `RedactionConfig` is the daemon's type and does not compare, so the
    // three settings are compared by hand rather than saving a file that did
    // not change.
    let changed = config.redaction.secrets != before.secrets
        || config.redaction.email_addresses != before.email_addresses
        || config.redaction.home_paths != before.home_paths;
    if changed {
        save_config(paths, &config)?;
    }
    Ok(CommandOutput {
        command: "redaction".to_owned(),
        data: json!({
            "redaction": config.redaction,
            "changed": changed,
            "appliesFrom": "the next capture"
        }),
    })
}
