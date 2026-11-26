//! Proving who the person at the keyboard is, for the commands that need the
//! account itself rather than the capture key stored on this computer.

use serde_json::{Value, json};
use std::io::{BufRead, IsTerminal};

use crate::api::ApiClient;
use crate::credential::Credential;
use crate::error::AppError;

/// The account credential named on the command line.
///
/// `--token` is taken as it is. `--email` and `--password` are exchanged for a
/// browser session. `--password -` reads the password from the first line of
/// standard input, so it need not sit in shell history or in the process
/// list, where every user on the machine can read it. `MEMOAR_PASSWORD` is the
/// other way to keep it off the command line.
pub(crate) fn sign_in(
    endpoint: &str,
    email: Option<&str>,
    password: Option<&str>,
    token: Option<&str>,
    command: &str,
) -> Result<Credential, AppError> {
    // An email decides it: the token may well be MEMOAR_TOKEN left in the
    // environment by something else, and the person typed the email.
    if let Some(token) = token.filter(|_| email.is_none()) {
        if token.trim().is_empty() {
            return Err(AppError::usage("--token cannot be empty"));
        }
        return Ok(Credential::classify(token.trim()));
    }
    let needed = || {
        AppError::usage(format!(
            "{command} requires --email and --password, or --token, when it cannot ask at a terminal"
        ))
    };
    // A person at a terminal is asked. A bare `memoar login` used to fail and
    // tell them to put their password on the command line.
    let interactive = std::io::stdin().is_terminal() && std::io::stderr().is_terminal();
    let email = match email.map(str::trim).filter(|email| !email.is_empty()) {
        Some(email) => email.to_owned(),
        None if interactive => prompt_line("Email: ")?,
        None => return Err(needed()),
    };
    let password = match password {
        Some("-") => read_password_line()?,
        Some(given) => given.to_owned(),
        None if interactive => rpassword::prompt_password("Password: ")
            .map_err(|error| AppError::usage(format!("could not read the password: {error}")))?,
        None => return Err(needed()),
    };
    let auth = ApiClient::new(endpoint, None).post(
        "/auth/login",
        &json!({ "email": email, "password": password }),
    )?;
    Ok(Credential::Bearer(
        auth.get("accessToken")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::network("login response did not include accessToken"))?
            .to_owned(),
    ))
}

fn prompt_line(prompt: &str) -> Result<String, AppError> {
    eprint!("{prompt}");
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|error| AppError::usage(format!("could not read the answer: {error}")))?;
    let answer = line.trim().to_owned();
    if answer.is_empty() {
        return Err(AppError::usage(format!(
            "{} cannot be empty",
            prompt.trim_end_matches([':', ' '])
        )));
    }
    Ok(answer)
}

fn read_password_line() -> Result<String, AppError> {
    let stdin = std::io::stdin();
    // At a terminal, leaving out --password asks without echoing it.
    if stdin.is_terminal() {
        return Err(AppError::usage(
            "--password - reads the password from a pipe, not a terminal. Leave --password out to be asked for it.",
        ));
    }
    let mut line = String::new();
    stdin.lock().read_line(&mut line).map_err(|error| {
        AppError::usage(format!("could not read the password from stdin: {error}"))
    })?;
    // Only the line ending goes: a password may well end in a space.
    let password = line.trim_end_matches(['\n', '\r']).to_owned();
    if password.is_empty() {
        return Err(AppError::usage(
            "--password - read an empty line from stdin",
        ));
    }
    Ok(password)
}

/// The archive URL as `login` will store it, or why it cannot be one.
///
/// `localhost:4000/v1` without a scheme, or a value with a stray space, used
/// to reach the HTTP client as it was and come back as an opaque "builder
/// error", reported as a network failure worth retrying.
pub(crate) fn validated_endpoint(raw: &str) -> Result<String, AppError> {
    let endpoint = raw.trim().trim_end_matches('/');
    if endpoint.is_empty() {
        return Err(AppError::usage("--endpoint cannot be empty"));
    }
    let parsed = reqwest::Url::parse(endpoint).map_err(|error| {
        AppError::usage(format!(
            "--endpoint {endpoint} is not a URL ({error}). It looks like https://memoar.example.com/v1"
        ))
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AppError::usage(format!(
            "--endpoint {endpoint} must be an http or https URL with a host, like https://memoar.example.com/v1"
        )));
    }
    Ok(endpoint.to_owned())
}
