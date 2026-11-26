//! `e`: the session's canonical export, written as a file.
//!
//! The same bundle the web app downloads, which the canonical-bundle ingest
//! source imports again. It is written next to where the TUI was started and
//! never over an existing file.

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use crate::api::ApiClient;
use crate::config::{RuntimePaths, authenticated_config};
use crate::error::AppError;

pub(crate) fn export(
    paths: &RuntimePaths,
    session_id: &str,
    directory: &Path,
) -> Result<PathBuf, AppError> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(AppError::usage(format!(
            "{session_id:?} is not a session id that can name a file"
        )));
    }
    let (config, token) = authenticated_config(paths)?;
    let bundle = ApiClient::new(&config.endpoint, Some(&token)).get_query(
        &format!("/sessions/{session_id}/export"),
        &[("format", "canonical".to_owned())],
    )?;
    let bytes = serde_json::to_vec_pretty(&bundle)
        .map_err(|error| AppError::internal(error.to_string()))?;
    let path = directory.join(format!("memoar-{session_id}.json"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| match error.kind() {
            ErrorKind::AlreadyExists => AppError::local(
                format!(
                    "memoar-{session_id}.json is already in {} and was left as it is.",
                    directory.display()
                ),
                "Move or delete it, then export again.",
            ),
            _ => AppError::local(
                format!("could not create {}: {error}", path.display()),
                "Start memoar tui from a directory you can write to.",
            ),
        })?;
    file.write_all(&bytes)
        .and_then(|()| file.write_all(b"\n"))
        .map_err(|error| {
            AppError::local(
                format!("could not write {}: {error}", path.display()),
                "Check the free space and permissions of the directory.",
            )
        })?;
    Ok(path)
}
