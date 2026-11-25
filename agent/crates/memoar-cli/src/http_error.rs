//! What an answer from the archive means, decided by its status.
//!
//! Every refusal used to arrive as `MEMOAR_NETWORK`, exit 4, `retryable:
//! true`, with "check the endpoint, connection, and credentials". A wrong
//! password, a revoked key and a machine somebody deregistered all told a
//! wrapper to try again, and `sync --watch` did, every five minutes, for ever.
//! A refusal is now exit 5 and not retryable. What is worth retrying, an
//! archive that is overloaded, restarting or rate limiting, stays exit 4.

use crate::api::problem_message;
use crate::error::{AppError, EXIT_NETWORK, EXIT_REFUSED};

/// The error for a non-success status, with the problem document's own words.
pub(crate) fn http_error(status: u16, body: &str) -> AppError {
    let message = problem_message(status, body);
    let (exit_code, code, kind, hint, retryable) = match status {
        401 => (
            EXIT_REFUSED,
            "MEMOAR_UNAUTHORIZED",
            "auth",
            "The archive does not accept this credential any more. Run memoar login to sign in again.",
            false,
        ),
        403 => (
            EXIT_REFUSED,
            "MEMOAR_FORBIDDEN",
            "auth",
            "This credential is not allowed to do that. Sign in with an account that is, or ask the archive owner.",
            false,
        ),
        404 => (
            EXIT_REFUSED,
            "MEMOAR_NOT_FOUND",
            "refused",
            "Check the id. memoar search lists the sessions this account can read.",
            false,
        ),
        429 => (
            EXIT_NETWORK,
            "MEMOAR_RATE_LIMITED",
            "network",
            "The archive is rate limiting this account. Wait a minute, then retry.",
            true,
        ),
        408 | 500..=599 => (
            EXIT_NETWORK,
            "MEMOAR_SERVER",
            "network",
            "The archive is having trouble. Retry shortly.",
            true,
        ),
        _ => (
            EXIT_REFUSED,
            "MEMOAR_REFUSED",
            "refused",
            "The archive refused the request as sent. Sending it again unchanged is refused the same way.",
            false,
        ),
    };
    AppError {
        exit_code,
        code: code.to_owned(),
        kind: kind.to_owned(),
        message,
        hint: hint.to_owned(),
        retryable,
        http_status: Some(status),
    }
}

/// This machine was deregistered from the archive, or never belonged to the
/// account signed in on it.
///
/// What `DELETE /machines/{id}` leaves behind. The machine is retired, so
/// updating it answers 404 and minting a token for it answers 401, and
/// neither of those generic messages says what happened or what to do.
pub(crate) fn machine_retired(machine_id: &str, cause: &AppError) -> AppError {
    AppError {
        exit_code: EXIT_REFUSED,
        code: "MEMOAR_MACHINE_RETIRED".to_owned(),
        kind: "auth".to_owned(),
        message: format!(
            "The archive no longer has machine {machine_id}: it was deregistered, or belongs to another account ({}).",
            cause.message
        ),
        hint: "Run memoar login to register this computer again. What is already queued here is kept and uploads after that.".to_owned(),
        retryable: false,
        http_status: cause.http_status,
    }
}

/// Whether a refusal of a machine-scoped request means the machine is gone.
///
/// The archive answers `PATCH /machines/{id}` for a retired machine with 404
/// and `POST /auth/machine-token` with 401. A 401 can also be the account
/// credential failing, so the status alone does not decide it: the machine
/// list does. `listed` is that lookup, run only when the status calls for it.
pub(crate) fn explain_machine_refusal(
    machine_id: &str,
    error: AppError,
    listed: impl FnOnce() -> Result<bool, AppError>,
) -> AppError {
    if !matches!(error.http_status, Some(401 | 404)) {
        return error;
    }
    match listed() {
        Ok(false) => machine_retired(machine_id, &error),
        _ => error,
    }
}
