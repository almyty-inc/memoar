//! macOS: a LaunchAgent in `~/Library/LaunchAgents`, in the user's GUI domain.
//!
//! `KeepAlive` is `SuccessfulExit: false`, so launchd restarts the service
//! after a crash or a non-zero exit, no faster than `ThrottleInterval`, and
//! leaves it stopped after a clean exit. The service exits 0 only when
//! retrying cannot help (a revoked key, a retired machine, a logout), which is
//! what keeps a dead credential from being restarted every half minute.

use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use super::exec::{run, run_ok, service_error};
use super::spec::ServiceSpec;
use super::{Installed, Query};
use crate::error::AppError;

pub(crate) const THROTTLE_SECONDS: u32 = 30;

pub(crate) fn label(name: &str) -> String {
    format!("dev.memoar.{name}")
}

pub(crate) fn definition_path(home: &Path, name: &str) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", label(name)))
}

/// The service manager's own output, for crashes only: the service writes
/// everything else to `agent.log` itself.
pub(crate) fn stdio_log(spec_log_dir: &Path) -> PathBuf {
    spec_log_dir.join("launchd.log")
}

pub(crate) fn render(spec: &ServiceSpec) -> Result<String, AppError> {
    let mut arguments = vec![spec.program_text()?];
    arguments.extend(spec.arguments.iter().cloned());
    let strings = arguments
        .iter()
        .map(|argument| format!("    <string>{}</string>\n", escape(argument)))
        .collect::<String>();
    let stdio = escape(&stdio_log(&spec.log_dir).to_string_lossy());
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{strings}  </array>
  <key>WorkingDirectory</key>
  <string>{working}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>{THROTTLE_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>{stdio}</string>
  <key>StandardErrorPath</key>
  <string>{stdio}</string>
</dict>
</plist>
"#,
        label = escape(&label(&spec.name)),
        working = escape(&spec.data_dir.to_string_lossy()),
    ))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn domain() -> Result<String, AppError> {
    let ran = run_ok("id", &["-u"])?;
    Ok(format!("gui/{}", ran.stdout.trim()))
}

pub(crate) fn install(spec: &ServiceSpec, home: &Path) -> Result<Installed, AppError> {
    let domain = domain()?;
    let target = format!("{domain}/{}", label(&spec.name));
    let path = definition_path(home, &spec.name);
    // Unloaded first, so a reinstall picks up the new definition and binary.
    let _ = run("launchctl", &["bootout", &target]);
    super::write_definition(&path, render(spec)?.as_bytes())?;
    // launchd creates the file it is told to write to with the default
    // mode. Created first, it keeps owner-only.
    let stdio = stdio_log(&spec.log_dir);
    if !stdio.exists() {
        let _ = crate::config::create_private(&stdio, 0o600);
    }
    let _ = run("launchctl", &["enable", &target]);
    let path_text = path.to_string_lossy().into_owned();
    // `bootout` returns before the job is gone, and a `bootstrap` that races
    // it fails with an I/O error. A few tries cover the gap.
    let mut last = None;
    for _ in 0..10 {
        let ran = run("launchctl", &["bootstrap", &domain, &path_text])?;
        if ran.ok() {
            return Ok(Installed {
                definition: path_text,
                notes: Vec::new(),
            });
        }
        last = Some(ran);
        thread::sleep(Duration::from_millis(500));
    }
    Err(service_error(
        format!(
            "launchctl bootstrap {domain} {path_text} failed, {}",
            last.map(|ran| ran.said()).unwrap_or_default()
        ),
        "Run `launchctl print gui/$(id -u)` to see whether a login session is available. A LaunchAgent needs one.",
    ))
}

pub(crate) fn uninstall(name: &str, home: &Path) -> Result<bool, AppError> {
    let target = format!("{}/{}", domain()?, label(name));
    let loaded = run("launchctl", &["bootout", &target])?.ok();
    let path = definition_path(home, name);
    let existed = path.exists();
    if existed {
        std::fs::remove_file(&path).map_err(|error| {
            service_error(
                format!("could not remove {}: {error}", path.display()),
                "Remove the file by hand.",
            )
        })?;
    }
    Ok(loaded || existed)
}

pub(crate) fn query(name: &str, home: &Path) -> Query {
    let defined = definition_path(home, name).exists();
    let Ok(domain) = domain() else {
        return Query::unknown(defined, "could not find the user id");
    };
    match run(
        "launchctl",
        &["print", &format!("{domain}/{}", label(name))],
    ) {
        Ok(ran) if ran.ok() => parse_print(&ran.stdout, defined),
        Ok(_) => Query {
            defined,
            loaded: false,
            running: Some(false),
            pid: None,
            detail: if defined {
                "defined but not loaded".to_owned()
            } else {
                "not installed".to_owned()
            },
        },
        Err(error) => Query::unknown(defined, &error.message),
    }
}

/// Reads `state`, `pid` and `last exit code` out of `launchctl print`.
pub(crate) fn parse_print(text: &str, defined: bool) -> Query {
    let field = |key: &str| {
        text.lines().find_map(|line| {
            let (name, value) = line.trim().split_once(" = ")?;
            (name == key).then(|| value.trim().to_owned())
        })
    };
    let state = field("state").unwrap_or_default();
    let pid = field("pid").and_then(|pid| pid.parse().ok());
    let running = state == "running";
    let mut detail = format!("launchd state {state}");
    if let Some(code) = field("last exit code") {
        detail.push_str(&format!(", last exit {code}"));
    }
    Query {
        defined,
        loaded: true,
        running: Some(running),
        pid,
        detail,
    }
}
