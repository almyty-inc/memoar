//! Signing this machine in and out, as `memoar login` does.

use memoar_cli::{Command, LoginArgs};

use crate::capture::{State, Status, status};
use crate::failure::{Failure, FailureKind, classify_sign_in};
use crate::paths::{Paths, base_cli};

/// What a person signs in with: the two forms `memoar login` accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credentials {
    Password {
        email: String,
        password: String,
    },
    /// An API key or access token, as `memoar login --token` takes it.
    ApiKey(String),
}

fn invalid(message: &str) -> Failure {
    Failure::new(FailureKind::Other, message, message)
}

/// Says what is missing before anything is sent.
///
/// # Errors
/// When the address or the credentials are empty or malformed.
pub fn validate(endpoint: &str, credentials: &Credentials) -> Result<(), Failure> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return Err(invalid("Enter the archive's address."));
    }
    if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
        return Err(invalid("The address must start with http:// or https://."));
    }
    match credentials {
        Credentials::Password { email, password }
            if email.trim().is_empty() || password.is_empty() =>
        {
            Err(invalid("Enter your email and password."))
        }
        Credentials::ApiKey(key) if key.trim().is_empty() => Err(invalid("Enter an API key.")),
        _ => Ok(()),
    }
}

/// What a first-time sign-in from the window asks for.
///
/// Secret masking is on. This is the path somebody who does not use a terminal
/// takes, and redaction cannot be applied backwards: whatever goes up unmasked
/// is in the archive, and turning the setting on afterwards does nothing for it.
/// A stray `[REDACTED]` in an archived transcript costs a little legibility, a
/// leaked key costs a rotation at best, so the default is the one whose mistake
/// is cheap.
///
/// Email addresses and home paths stay off. Those are ordinarily part of what
/// makes a transcript readable later.
///
/// This is a default, not a decision: the toggles are in the window, and
/// `set_redaction` writes whatever the reader chooses.
pub(crate) fn login_args(endpoint: &str, credentials: &Credentials) -> LoginArgs {
    let (email, password, token) = match credentials {
        Credentials::Password { email, password } => {
            (Some(email.trim().to_owned()), Some(password.clone()), None)
        }
        Credentials::ApiKey(key) => (None, None, Some(key.trim().to_owned())),
    };
    LoginArgs {
        endpoint: Some(endpoint.trim().to_owned()),
        email,
        password,
        token,
        machine_id: None,
        redact_secrets: true,
        redact_email_addresses: false,
        redact_home_paths: false,
    }
}

/// Signs in, registering this machine or reusing the one it already is.
///
/// # Errors
/// When the input is incomplete, the archive refuses the credentials or it
/// cannot be reached.
pub fn sign_in(
    paths: &Paths,
    state: &State,
    endpoint: &str,
    credentials: &Credentials,
) -> Result<Status, Failure> {
    validate(endpoint, credentials)?;
    let command = Command::Login(login_args(endpoint, credentials));
    memoar_cli::execute(&base_cli(command), &paths.runtime())
        .map_err(|error| classify_sign_in(&error, endpoint.trim()))?;
    state.forget();
    Ok(status(paths, state))
}

/// Forgets this machine's credential and keeps everything else.
///
/// `config.json` stays, so signing in again reuses the same machine record
/// rather than enrolling a second one, and the offline queue stays, so nothing
/// captured but not yet uploaded is lost.
///
/// # Errors
/// When the credential file exists and cannot be removed.
pub fn sign_out(paths: &Paths, state: &State) -> Result<Status, Failure> {
    let file = paths.credentials_file();
    match std::fs::remove_file(&file) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            let detail = format!("could not remove {}: {error}", file.display());
            return Err(Failure::new(
                FailureKind::Other,
                "Could not sign out: the credential file could not be removed.",
                detail,
            ));
        }
    }
    state.forget();
    Ok(status(paths, state))
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod tests;
