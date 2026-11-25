//! Whose service a name is.
//!
//! Service names are per user, and configuration directories are not: a
//! scratch configuration installed under the default name would otherwise
//! quietly replace the service capturing for the real one.

use std::fs;

use super::exec::run;
use super::{launchd, schtasks, service_home, systemd};
use crate::config::RuntimePaths;
use crate::dirs::Platform;
use crate::error::AppError;

/// The definition the platform holds for `name`, as text, when there is one.
fn existing_definition(name: &str) -> Result<Option<String>, AppError> {
    let home = service_home()?;
    let path = match Platform::current() {
        Platform::Macos => launchd::definition_path(&home, name),
        Platform::OtherUnix => systemd::definition_path(&home, name),
        Platform::Windows => {
            let task = schtasks::task_name(name);
            let ran = run("schtasks", &["/Query", "/TN", &task, "/XML"])?;
            return Ok(ran.ok().then_some(ran.stdout));
        }
    };
    Ok(fs::read_to_string(path).ok())
}

/// Whether a definition names this configuration directory as a whole
/// argument, so `/a/config` does not match a service for `/a/config-2`.
pub(crate) fn names_config_dir(definition: &str, config_dir: &str) -> bool {
    ["<", "\"", "&", " ", "\n"]
        .iter()
        .any(|end| definition.contains(&format!("{config_dir}{end}")))
}

/// Refuses to replace or remove a service that belongs to another
/// configuration directory, unless forced.
pub(crate) fn check_owner(name: &str, paths: &RuntimePaths, force: bool) -> Result<(), AppError> {
    let Some(definition) = existing_definition(name)? else {
        return Ok(());
    };
    let config_dir = paths.config_dir.to_string_lossy();
    if force || names_config_dir(&definition, &config_dir) {
        return Ok(());
    }
    Err(AppError::usage(format!(
        "a service named {name:?} is installed for another configuration directory, not {config_dir}"
    ))
    .with_hint(
        "Pass --name to give this configuration a service of its own, or --force to take the name over.",
    ))
}
