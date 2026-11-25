//! What a sync asks of the archive besides the uploads themselves.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::api::ApiClient;
use crate::error::AppError;

/// The project roots this account has archived sessions in, kept inside the
/// home this machine captures from.
///
/// Which directories are projects is not something the agent can know by
/// looking: a home directory is full of checkouts nobody works in. The archive
/// already knows, because a transcript names the directory it was recorded in,
/// so memory files are captured for the projects actually being worked on and
/// nowhere else. A failure here means no project files this sweep, not a failed
/// sync — the transcripts are the point.
///
/// But a `workspace` is a string the server chose, and it was being used as a
/// local read root on the strength of `is_absolute() && is_dir()` alone. An
/// archive that was compromised, or simply wrong, could answer
/// `"workspace": "/Users/someone-else"` and this machine would read instruction
/// files out of it and upload them. The server does not get to choose which
/// local files the client reads: the capture home is the only directory the
/// person running the agent nominated, so a root outside it is discarded.
/// Both sides are canonicalised first, because `..` and a symlink pointing out
/// of the home are the same trick spelled differently.
pub(crate) fn archived_workspaces(api: &ApiClient, home: &Path) -> Vec<PathBuf> {
    let Ok(response) = api.get_query("/sessions", &[("limit", "100".to_owned())]) else {
        return Vec::new();
    };
    let Ok(home) = home.canonicalize() else {
        return Vec::new();
    };
    let mut roots: BTreeSet<PathBuf> = BTreeSet::new();
    for session in response["items"].as_array().unwrap_or(&Vec::new()) {
        let Some(workspace) = session["workspace"].as_str() else {
            continue;
        };
        let path = PathBuf::from(workspace);
        // Canonicalising answers "does it exist" and "where does it really
        // lead" in one step; an absolute path is still required first so a
        // relative one is never resolved against this process's directory.
        if !path.is_absolute() {
            continue;
        }
        let Ok(path) = path.canonicalize() else {
            continue;
        };
        if path.is_dir() && path.starts_with(&home) {
            roots.insert(path);
        }
    }
    roots.into_iter().collect()
}

/// A refusal of the machine token, as opposed to the account credential.
///
/// The ingest requests are made with the short-lived machine token, and this
/// cycle has just used the account key to update the machine and mint that
/// token. So a 401 or 403 here is the token, revoked with `POST
/// /machines/{id}/tokens/revoke` after it was minted, and the contract says
/// the agent mints a new one at its next cycle. Reported as retryable, so a
/// watch waits a cycle instead of stopping over a lever made to be recovered
/// from. If the account itself was revoked, the next cycle fails before this
/// point, on a request made with it, and that one stops the watch.
pub(crate) fn machine_token_refusal(error: AppError) -> AppError {
    if !matches!(error.http_status, Some(401 | 403)) {
        return error;
    }
    AppError {
        code: "MEMOAR_MACHINE_TOKEN_REFUSED".to_owned(),
        kind: "network".to_owned(),
        exit_code: crate::error::EXIT_NETWORK,
        hint: "The machine token was revoked after it was issued. The next sync mints a new one, so run it again.".to_owned(),
        retryable: true,
        ..error
    }
}
