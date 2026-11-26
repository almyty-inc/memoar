//! What registering, or unregistering, memoar's MCP server changes in one
//! agent's config file.

use serde_json::Value;

use super::agents::{Agent, Env, Format, Launch, SERVER_NAME};
use super::write::{FileOp, read_existing};
use super::{json_file, toml_file, yaml_file};
use crate::error::AppError;

pub(crate) fn plan_mcp(
    agent: &Agent,
    env: &Env<'_>,
    launch: &Launch,
    uninstall: bool,
) -> Result<FileOp, AppError> {
    let path = (agent.config)(env);
    let previous = read_existing(&path)?;
    if uninstall {
        let Some(text) = previous else {
            return Ok(FileOp::Delete {
                path,
                present: false,
            });
        };
        let next = match agent.format {
            Format::Json(keys) => json_file::uninstall(&path, &text, keys, SERVER_NAME)?,
            Format::Toml(key) => toml_file::uninstall(&path, &text, key, SERVER_NAME)?,
            Format::Yaml(key) => yaml_file::uninstall(&path, &text, key, SERVER_NAME)?,
        };
        return Ok(match next {
            Some(next) => FileOp::Write {
                path,
                previous: Some(text),
                next,
                removing: true,
            },
            // Nothing of memoar's in it: the file is not memoar's to delete.
            None => FileOp::Delete {
                path,
                present: false,
            },
        });
    }
    let entry = (agent.entry)(launch);
    let text = previous.as_deref();
    let next = match agent.format {
        Format::Json(keys) => json_file::install(&path, text, keys, SERVER_NAME, &entry)?,
        Format::Toml(key) => toml_file::install(&path, text, key, SERVER_NAME, &entry)?,
        Format::Yaml(key) => yaml_file::install(&path, text, key, SERVER_NAME, &entry)?,
    };
    Ok(FileOp::Write {
        path,
        previous,
        next,
        removing: false,
    })
}

/// `missing`, `current`, or `different` (registered, but not as this binary
/// would register it now).
pub(crate) fn mcp_status(agent: &Agent, env: &Env<'_>, launch: &Launch) -> &'static str {
    let path = (agent.config)(env);
    let Ok(Some(text)) = read_existing(&path) else {
        return "missing";
    };
    let entry = (agent.entry)(launch);
    let matches = match agent.format {
        Format::Json(keys) => {
            json_file::current(&path, &text, keys, SERVER_NAME).map(|found| found == entry)
        }
        Format::Toml(key) => {
            toml_file::current(&path, &text, key, SERVER_NAME).map(|found| found == entry)
        }
        Format::Yaml(key) => yaml_file::current(&text, key, SERVER_NAME, &entry),
    };
    match matches {
        None => "missing",
        Some(true) => "current",
        Some(false) => "different",
    }
}

/// The entry as it would be written, for a person adding it by hand.
pub(crate) fn snippet(agent: &Agent, launch: &Launch) -> Value {
    (agent.entry)(launch)
}
