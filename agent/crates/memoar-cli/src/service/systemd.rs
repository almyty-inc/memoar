//! Linux: a systemd user unit in `$XDG_CONFIG_HOME/systemd/user`.
//!
//! `Restart=on-failure` brings the service back after a crash or a non-zero
//! exit. The service exits 0 when retrying cannot help, and the exit codes
//! that mean the same thing are listed in `RestartPreventExitStatus` as well,
//! so neither path restart-loops on a revoked key.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::exec::{run, run_ok, service_error};
use super::spec::ServiceSpec;
use super::{Installed, Query};
use crate::error::AppError;

pub(crate) const RESTART_SECONDS: u32 = 30;

pub(crate) fn unit_name(name: &str) -> String {
    format!("memoar-{name}.service")
}

pub(crate) fn unit_dir(home: &Path, xdg_config_home: Option<OsString>) -> PathBuf {
    xdg_config_home
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".config"))
        .join("systemd")
        .join("user")
}

pub(crate) fn definition_path(home: &Path, name: &str) -> PathBuf {
    unit_dir(home, std::env::var_os("XDG_CONFIG_HOME")).join(unit_name(name))
}

pub(crate) fn render(spec: &ServiceSpec) -> Result<String, AppError> {
    let mut command = vec![quote(&spec.program_text()?)];
    command.extend(spec.arguments.iter().map(|argument| quote(argument)));
    Ok(format!(
        "[Unit]
Description=Memoar background capture ({name})
Documentation=https://github.com/almyty-inc/memoar/blob/main/docs/install.md
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart={exec}
WorkingDirectory={working}
Restart=on-failure
RestartSec={RESTART_SECONDS}
RestartPreventExitStatus=2 3 5
TimeoutStopSec=15

[Install]
WantedBy=default.target
",
        name = spec.name,
        exec = command.join(" "),
        working = specifiers(&spec.data_dir.to_string_lossy()),
    ))
}

/// One `ExecStart` word: double-quoted, with the quoting, specifier and
/// variable characters systemd would otherwise interpret escaped.
pub(crate) fn quote(argument: &str) -> String {
    let escaped = specifiers(argument)
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "$$");
    format!("\"{escaped}\"")
}

fn specifiers(text: &str) -> String {
    text.replace('%', "%%")
}

/// Whether a systemd user manager is there to talk to.
pub(crate) fn available() -> Result<(), AppError> {
    let fallback = "Without a systemd user session, start capture from your desktop's autostart or a `@reboot` crontab line instead: `memoar sync --watch`, with the same --config-dir, --data-dir and --capture-home you pass here.";
    if !Path::new("/run/systemd/system").exists() {
        return Err(service_error(
            "this system was not booted with systemd, so there is no user service manager to install into",
            fallback,
        ));
    }
    let ran = run("systemctl", &["--user", "show-environment"])?;
    if !ran.ok() {
        return Err(service_error(
            format!(
                "systemctl --user cannot reach a user service manager, {}",
                ran.said()
            ),
            fallback,
        ));
    }
    Ok(())
}

pub(crate) fn install(spec: &ServiceSpec, home: &Path) -> Result<Installed, AppError> {
    available()?;
    let path = definition_path(home, &spec.name);
    let unit = unit_name(&spec.name);
    super::write_definition(&path, render(spec)?.as_bytes())?;
    run_ok("systemctl", &["--user", "daemon-reload"])?;
    run_ok("systemctl", &["--user", "enable", &unit])?;
    // `restart`, not `start`: a reinstall must pick up the new definition.
    run_ok("systemctl", &["--user", "restart", &unit])?;
    let mut notes = Vec::new();
    if !lingering() {
        notes.push("The service runs while you are logged in. To keep capturing after you log out, run `loginctl enable-linger` once (it may ask for your password).".to_owned());
    }
    Ok(Installed {
        definition: path.to_string_lossy().into_owned(),
        notes,
    })
}

fn lingering() -> bool {
    let user = std::env::var("USER").unwrap_or_default();
    if user.is_empty() {
        return false;
    }
    run("loginctl", &["show-user", &user, "--property=Linger"])
        .is_ok_and(|ran| ran.stdout.trim() == "Linger=yes")
}

pub(crate) fn uninstall(name: &str, home: &Path) -> Result<bool, AppError> {
    let unit = unit_name(name);
    let path = definition_path(home, name);
    let existed = path.exists();
    let stopped =
        run("systemctl", &["--user", "disable", "--now", &unit]).is_ok_and(|ran| ran.ok());
    if existed {
        std::fs::remove_file(&path).map_err(|error| {
            service_error(
                format!("could not remove {}: {error}", path.display()),
                "Remove the file by hand, then run `systemctl --user daemon-reload`.",
            )
        })?;
    }
    let _ = run("systemctl", &["--user", "daemon-reload"]);
    let _ = run("systemctl", &["--user", "reset-failed", &unit]);
    Ok(existed || stopped)
}

pub(crate) fn query(name: &str, home: &Path) -> Query {
    let defined = definition_path(home, name).exists();
    let unit = unit_name(name);
    match run(
        "systemctl",
        &[
            "--user",
            "show",
            &unit,
            "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus",
        ],
    ) {
        Ok(ran) if ran.ok() => parse_show(&ran.stdout, defined),
        Ok(ran) => Query::unknown(defined, &ran.said()),
        Err(error) => Query::unknown(defined, &error.message),
    }
}

/// Reads `systemctl show` properties into a verdict.
///
/// `activating` with `auto-restart` is systemd waiting out `RestartSec`
/// before the next start, which counts as running: it is coming back.
pub(crate) fn parse_show(text: &str, defined: bool) -> Query {
    let field = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(&format!("{key}=")).map(str::to_owned))
            .unwrap_or_default()
    };
    let load = field("LoadState");
    let active = field("ActiveState");
    let sub = field("SubState");
    let loaded = load == "loaded";
    let running = active == "active" || (active == "activating" && sub == "auto-restart");
    let mut detail = format!("systemd {active} ({sub})");
    let status = field("ExecMainStatus");
    if !running && !status.is_empty() && status != "0" {
        detail.push_str(&format!(", last exit {status}"));
    }
    Query {
        defined,
        loaded,
        running: Some(loaded && running),
        pid: field("MainPID").parse().ok().filter(|pid| *pid != 0),
        detail,
    }
}
