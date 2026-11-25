//! Windows: a per-user Scheduled Task that starts at logon.
//!
//! `memoar.exe` is a console program, and Task Scheduler gives a console
//! program a console window, which would flash up at every logon and every
//! restart. The action runs it under `conhost.exe --headless`, which hosts the
//! console without a window. The service restarts its own watch after a
//! failure, and the task's `RestartOnFailure` covers the service itself.

use std::path::{Path, PathBuf};

use super::exec::{run, run_ok};
use super::spec::ServiceSpec;
use super::{Installed, Query};
use crate::error::AppError;

pub(crate) fn task_name(name: &str) -> String {
    format!("\\Memoar\\{name}")
}

/// `conhost.exe` in the system directory, when there is one.
pub(crate) fn conhost() -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let path = PathBuf::from(root).join("System32").join("conhost.exe");
    path.is_file().then_some(path)
}

/// The account the task belongs to, as `DOMAIN\user`.
pub(crate) fn current_user() -> Result<String, AppError> {
    if let (Ok(domain), Ok(user)) = (std::env::var("USERDOMAIN"), std::env::var("USERNAME"))
        && !domain.is_empty()
        && !user.is_empty()
    {
        return Ok(format!("{domain}\\{user}"));
    }
    Ok(run_ok("whoami", &[])?.stdout.trim().to_owned())
}

/// The task definition. `host` is the headless console host, or `None` to
/// start the program directly.
pub(crate) fn render(
    spec: &ServiceSpec,
    user: &str,
    host: Option<&Path>,
) -> Result<String, AppError> {
    let program = spec.program_text()?;
    let arguments = spec
        .arguments
        .iter()
        .map(|argument| quote(argument))
        .collect::<Vec<_>>()
        .join(" ");
    let (command, arguments) = match host {
        Some(host) => (
            host.to_string_lossy().into_owned(),
            format!("--headless {} {arguments}", quote(&program)),
        ),
        None => (program, arguments),
    };
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Memoar background capture ({name}). Runs memoar sync --watch.</Description>
    <URI>{uri}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
      <WorkingDirectory>{working}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"#,
        name = escape(&spec.name),
        uri = escape(&task_name(&spec.name)),
        user = escape(user),
        command = escape(&command),
        arguments = escape(&arguments),
        working = escape(&spec.data_dir.to_string_lossy()),
    ))
}

/// One argument as `CommandLineToArgvW` will split it back out.
pub(crate) fn quote(argument: &str) -> String {
    if !argument.is_empty() && !argument.contains([' ', '\t', '\n', '"']) {
        return argument.to_owned();
    }
    let mut quoted = String::from('"');
    let mut backslashes = 0_usize;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            other => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(other);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `schtasks /XML` reads UTF-16 with a byte order mark reliably, and UTF-8
/// only sometimes.
pub(crate) fn utf16_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

pub(crate) fn install(spec: &ServiceSpec) -> Result<Installed, AppError> {
    let task = task_name(&spec.name);
    let host = conhost();
    let xml = render(spec, &current_user()?, host.as_deref())?;
    let file = spec.log_dir.join(format!(".task-{}.xml", spec.name));
    super::write_definition(&file, &utf16_with_bom(&xml))?;
    let _ = run("schtasks", &["/End", "/TN", &task]);
    let created = run_ok(
        "schtasks",
        &[
            "/Create",
            "/TN",
            &task,
            "/XML",
            &file.to_string_lossy(),
            "/F",
        ],
    );
    let _ = std::fs::remove_file(&file);
    created?;
    run_ok("schtasks", &["/Run", "/TN", &task])?;
    let mut notes = Vec::new();
    if host.is_none() {
        notes.push("conhost.exe was not found, so the task starts memoar.exe directly and a console window may appear at logon.".to_owned());
    }
    Ok(Installed {
        definition: format!("Task Scheduler {task}"),
        notes,
    })
}

/// Ends and deletes the task, then any service process that outlived it.
pub(crate) fn uninstall(name: &str, survivors: &[u32]) -> Result<bool, AppError> {
    let task = task_name(name);
    let existed = run("schtasks", &["/Query", "/TN", &task])?.ok();
    if existed {
        let _ = run("schtasks", &["/End", "/TN", &task]);
        run_ok("schtasks", &["/Delete", "/TN", &task, "/F"])?;
    }
    for pid in survivors {
        if memoar_alive(*pid) {
            let _ = run("taskkill", &["/PID", &pid.to_string(), "/T", "/F"]);
        }
    }
    Ok(existed)
}

/// Task Scheduler's status column is translated, so whether the service is
/// running is answered by whether the process it recorded is still alive.
pub(crate) fn query(name: &str, service_pid: Option<u32>) -> Query {
    match run("schtasks", &["/Query", "/TN", &task_name(name)]) {
        Ok(ran) if ran.ok() => {
            let running = service_pid.is_some_and(memoar_alive);
            Query {
                defined: true,
                loaded: true,
                running: Some(running),
                pid: service_pid.filter(|_| running),
                detail: if running {
                    "scheduled task running".to_owned()
                } else {
                    "scheduled task not running".to_owned()
                },
            }
        }
        Ok(_) => Query {
            defined: false,
            loaded: false,
            running: Some(false),
            pid: None,
            detail: "no scheduled task".to_owned(),
        },
        Err(error) => Query::unknown(false, &error.message),
    }
}

/// Whether `pid` is a live `memoar.exe`. The image name guards against a
/// recycled process id.
pub(crate) fn memoar_alive(pid: u32) -> bool {
    run(
        "tasklist",
        &["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"],
    )
    .is_ok_and(|ran| ran.stdout.to_ascii_lowercase().contains("\"memoar"))
}
