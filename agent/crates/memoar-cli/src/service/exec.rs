//! Running the platform's service tools: `launchctl`, `systemctl`, `schtasks`.

use std::process::{Command, Stdio};

use crate::error::AppError;

#[derive(Debug, Clone)]
pub(crate) struct Ran {
    pub(crate) code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

impl Ran {
    pub(crate) fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// The tool's own words, for an error message.
    pub(crate) fn said(&self) -> String {
        let text = if self.stderr.trim().is_empty() {
            self.stdout.trim()
        } else {
            self.stderr.trim()
        };
        match self.code {
            Some(code) => format!("exit {code}: {text}"),
            None => format!("killed: {text}"),
        }
    }
}

/// Runs a tool and collects what it said. Only failing to start it at all is
/// an error here: what a non-zero exit means is the caller's to decide.
pub(crate) fn run(program: &str, arguments: &[&str]) -> Result<Ran, AppError> {
    let output = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            service_error(
                format!("could not run {program}: {error}"),
                format!("{program} is how this platform runs background services, and it is not available here."),
            )
        })?;
    Ok(Ran {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Runs a tool and fails with what it said unless it succeeded.
pub(crate) fn run_ok(program: &str, arguments: &[&str]) -> Result<Ran, AppError> {
    let ran = run(program, arguments)?;
    if ran.ok() {
        return Ok(ran);
    }
    Err(service_error(
        format!("{program} {} failed, {}", arguments.join(" "), ran.said()),
        "Run `memoar service status` for the service's state, and `memoar service logs` for what it last did.",
    ))
}

/// The service manager refused, or is not there. Exit 9: nothing about the
/// command line is wrong, and nothing on the archive side is involved.
pub(crate) fn service_error(message: impl Into<String>, hint: impl Into<String>) -> AppError {
    AppError {
        code: "MEMOAR_SERVICE".to_owned(),
        kind: "service".to_owned(),
        hint: hint.into(),
        ..AppError::internal(message)
    }
}
