//! `memoar service`: keep capture running in the background.
//!
//! `memoar sync --watch` ran only while a terminal held it. Closing that
//! terminal ended capture without a word, and on one laptop nothing reached
//! the archive for two months. This installs a per-user service in the
//! platform's own manager (launchd, systemd, Task Scheduler) that starts at
//! login, restarts the watch after a failure, stops for good on a failure
//! retrying cannot fix, and logs to the data directory.

pub(crate) mod args;
mod exec;
pub(crate) mod launchd;
pub(crate) mod logfile;
pub(crate) mod owner;
pub(crate) mod schtasks;
pub(crate) mod spec;
pub(crate) mod supervisor;
pub(crate) mod systemd;
mod view;

pub(crate) use view::{background, background_with, remove_for_logout};

use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use self::args::{ServiceChangeArgs, ServiceCommand, ServiceLogsArgs, ServiceNameArgs};
use self::exec::service_error;
use self::owner::check_owner;
use self::spec::{
    DEFAULT_NAME, ServiceRecord, ServiceSpec, absolute_paths, current_program, load_record,
    log_file, program_note, remove_record, save_record, validate_name,
};
use crate::CommandOutput;
use crate::config::{RuntimePaths, authenticated_config, create_private_dir, user_home};
use crate::dirs::Platform;
use crate::error::AppError;

/// What installing produced, for the report.
pub(crate) struct Installed {
    pub(crate) definition: String,
    pub(crate) notes: Vec<String>,
}

/// What the service manager says about one service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Query {
    /// Its definition file or task exists.
    pub(crate) defined: bool,
    /// The manager has it loaded.
    pub(crate) loaded: bool,
    /// `None` when the manager could not be asked.
    pub(crate) running: Option<bool>,
    pub(crate) pid: Option<u32>,
    pub(crate) detail: String,
}

impl Query {
    pub(crate) fn unknown(defined: bool, why: &str) -> Self {
        Self {
            defined,
            loaded: false,
            running: None,
            pid: None,
            detail: format!("could not ask the service manager: {why}"),
        }
    }
}

pub(crate) fn service(
    command: &ServiceCommand,
    paths: &RuntimePaths,
    json_mode: bool,
) -> Result<CommandOutput, AppError> {
    match command {
        ServiceCommand::Install(args) => install(args, paths),
        ServiceCommand::Uninstall(args) => uninstall(args, paths),
        ServiceCommand::Status(args) => status(args, paths),
        ServiceCommand::Logs(args) => logs(args, paths, json_mode),
        ServiceCommand::Run(args) => {
            let name = resolve_name(args, paths)?;
            supervisor::run(&name, paths)
        }
    }
}

pub(crate) fn manager() -> &'static str {
    match Platform::current() {
        Platform::Macos => "launchd",
        Platform::OtherUnix => "systemd",
        Platform::Windows => "task-scheduler",
    }
}

/// The home the service manager's files live under. Not `--capture-home`,
/// which only says where sessions are read from.
fn service_home() -> Result<PathBuf, AppError> {
    user_home(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
}

fn resolve_name(args: &ServiceNameArgs, paths: &RuntimePaths) -> Result<String, AppError> {
    let recorded = load_record(paths).map(|record| record.name);
    validate_name(
        args.name
            .as_deref()
            .or(recorded.as_deref())
            .unwrap_or(DEFAULT_NAME),
    )
}

pub(crate) fn write_definition(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let failed = |error: std::io::Error| {
        service_error(
            format!("could not write {}: {error}", path.display()),
            "Check that the directory is writable.",
        )
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(failed)?;
    }
    fs::write(path, bytes).map_err(failed)
}

pub(crate) fn query(name: &str, paths: &RuntimePaths) -> Query {
    let home = match service_home() {
        Ok(home) => home,
        Err(error) => return Query::unknown(false, &error.message),
    };
    match Platform::current() {
        Platform::Macos => launchd::query(name, &home),
        Platform::OtherUnix => systemd::query(name, &home),
        Platform::Windows => {
            schtasks::query(name, supervisor::load_state(paths).map(|state| state.pid))
        }
    }
}

fn install(args: &ServiceChangeArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let paths = absolute_paths(paths)?;
    // A service for a configuration nobody signed in would stop at once.
    authenticated_config(&paths)?;
    let name = resolve_name(&args.service, &paths)?;
    if let Some(record) = load_record(&paths).filter(|record| record.name != name)
        && !args.force
    {
        return Err(AppError::usage(format!(
            "this configuration already has a service named {:?}",
            record.name
        ))
        .with_hint("Two services on one queue take turns holding it. Run `memoar service uninstall` first, or pass --force."));
    }
    check_owner(&name, &paths, args.force)?;
    let program = current_program()?;
    let spec = ServiceSpec::new(&name, &program, &paths)?;
    create_private_dir(&spec.log_dir)?;
    // Asked before the service starts, or its own watch would be the answer.
    // A previous install's watch is not a competitor either.
    let previous_watch = supervisor::load_state(&paths).and_then(|state| state.child_pid);
    let competitor = crate::lock::sync_holder(&paths)
        .flatten()
        .filter(|pid| Some(*pid) != previous_watch);
    let installed = match Platform::current() {
        Platform::Macos => launchd::install(&spec, &service_home()?)?,
        Platform::OtherUnix => systemd::install(&spec, &service_home()?)?,
        Platform::Windows => schtasks::install(&spec)?,
    };
    save_record(
        &paths,
        &ServiceRecord {
            name: name.clone(),
            manager: manager().to_owned(),
            definition: installed.definition.clone(),
            program: program.clone(),
            installed_at: chrono::Utc::now(),
        },
    )?;
    let mut notes = installed.notes;
    notes.extend(program_note(&program));
    if let Some(pid) = competitor {
        notes.push(format!("A sync (process {pid}) already holds this queue. The service waits and takes over when it ends."));
    }
    let state = query(&name, &paths);
    Ok(CommandOutput {
        command: "service install".to_owned(),
        data: json!({
            "installed": true,
            "name": name,
            "manager": manager(),
            "definition": installed.definition,
            "program": program,
            "arguments": spec.arguments,
            "log": log_file(&paths),
            "running": state.running,
            "detail": state.detail,
            "notes": notes,
        }),
    })
}

/// Stops and removes the service `name`, and forgets it if it was this
/// configuration's.
pub(crate) fn remove(name: &str, paths: &RuntimePaths) -> Result<bool, AppError> {
    let removed = match Platform::current() {
        Platform::Macos => launchd::uninstall(name, &service_home()?)?,
        Platform::OtherUnix => systemd::uninstall(name, &service_home()?)?,
        Platform::Windows => {
            let state = supervisor::load_state(paths).unwrap_or_default();
            let survivors: Vec<u32> = std::iter::once(state.pid)
                .chain(state.child_pid)
                .filter(|pid| *pid != 0)
                .collect();
            schtasks::uninstall(name, &survivors)?
        }
    };
    if load_record(paths).is_some_and(|record| record.name == name) {
        remove_record(paths);
    }
    Ok(removed)
}

fn uninstall(args: &ServiceChangeArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let paths = absolute_paths(paths)?;
    let name = resolve_name(&args.service, &paths)?;
    check_owner(&name, &paths, args.force)?;
    let removed = remove(&name, &paths)?;
    Ok(CommandOutput {
        command: "service uninstall".to_owned(),
        data: json!({
            "removed": removed,
            "name": name,
            "manager": manager(),
            "detail": if removed { "stopped and removed" } else { "no such service was installed" },
        }),
    })
}

fn status(args: &ServiceNameArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let paths = absolute_paths(paths)?;
    let name = resolve_name(args, &paths)?;
    let record = load_record(&paths);
    let state = query(&name, &paths);
    let (health, _) = background(&paths);
    Ok(CommandOutput {
        command: "service status".to_owned(),
        data: json!({
            "installed": state.defined || record.as_ref().is_some_and(|record| record.name == name),
            "name": name,
            "manager": manager(),
            "definition": record.map(|record| record.definition),
            "running": state.running,
            "pid": state.pid,
            "detail": state.detail,
            "log": log_file(&paths),
            "service": supervisor::load_state(&paths),
            "backgroundCapture": health,
        }),
    })
}

fn logs(
    args: &ServiceLogsArgs,
    paths: &RuntimePaths,
    json_mode: bool,
) -> Result<CommandOutput, AppError> {
    let path = log_file(&absolute_paths(paths)?);
    let lines = logfile::tail(&path, args.lines);
    let data = if json_mode {
        json!({ "log": path, "lines": lines })
    } else if lines.is_empty() {
        Value::String(format!(
            "{} is empty or missing: the service has not run yet.",
            path.display()
        ))
    } else {
        Value::String(lines.join("\n"))
    };
    Ok(CommandOutput {
        command: "service logs".to_owned(),
        data,
    })
}
