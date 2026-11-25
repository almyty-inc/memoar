use memoar_daemon::DaemonError;
use memoar_materializer::MaterializeError;
use serde::Serialize;

pub const EXIT_OK: u8 = 0;
pub const EXIT_USAGE: u8 = 2;
pub const EXIT_NOT_INITIALIZED: u8 = 3;
pub const EXIT_NETWORK: u8 = 4;
/// The archive was reached, understood the request, and said no.
///
/// Distinct from `EXIT_NETWORK` on purpose. A conversion the archive refuses
/// and a conversion the archive never answers are the same exit code only if
/// you believe a script should retry both, and one of them will be refused
/// identically forever.
pub const EXIT_REFUSED: u8 = 5;
pub const EXIT_LOCKED: u8 = 7;
pub const EXIT_UNKNOWN: u8 = 9;

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    #[serde(skip)]
    pub exit_code: u8,
    pub code: String,
    pub kind: String,
    pub message: String,
    pub hint: String,
    pub retryable: bool,
    /// The status the archive answered with, when it answered at all.
    ///
    /// Kept so a caller can decide what a refusal means without reading the
    /// prose: `sync --watch` and `doctor` used to match on the message text.
    #[serde(skip)]
    pub http_status: Option<u16>,
}

impl AppError {
    #[must_use]
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            exit_code: EXIT_USAGE,
            code: "MEMOAR_USAGE".to_owned(),
            kind: "usage".to_owned(),
            message: message.into(),
            hint: "Run memoar introspect for the command surface.".to_owned(),
            retryable: false,
            http_status: None,
        }
    }

    #[must_use]
    pub fn not_initialized() -> Self {
        Self {
            exit_code: EXIT_NOT_INITIALIZED,
            code: "MEMOAR_NOT_INITIALIZED".to_owned(),
            kind: "not_initialized".to_owned(),
            message: "Memoar is not initialized on this machine.".to_owned(),
            hint: "Run memoar login.".to_owned(),
            retryable: false,
            http_status: None,
        }
    }

    #[must_use]
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            exit_code: EXIT_NETWORK,
            code: "MEMOAR_NETWORK".to_owned(),
            kind: "network".to_owned(),
            message: message.into(),
            hint: "Check the endpoint, connection, and credentials, then retry.".to_owned(),
            retryable: true,
            http_status: None,
        }
    }

    /// The archive answered, and the answer was no.
    ///
    /// `retryable` is false and the exit code is its own, because the whole
    /// value of this error is that it is not the network one: running the same
    /// command again produces the same refusal, and a CI step that retries on
    /// exit 4 would do it forever.
    #[must_use]
    pub fn refused(
        code: impl Into<String>,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self {
            exit_code: EXIT_REFUSED,
            code: code.into(),
            kind: "refused".to_owned(),
            message: message.into(),
            hint: hint.into(),
            retryable: false,
            http_status: None,
        }
    }

    /// The archive accepted the work and has not finished it inside the window
    /// this invocation was willing to wait.
    ///
    /// Still exit 4 — waiting longer is a real remedy — but its own code, so a
    /// caller can tell "still running" from "could not be reached" without
    /// reading the prose.
    #[must_use]
    pub fn timed_out(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            exit_code: EXIT_NETWORK,
            code: "MEMOAR_TIMEOUT".to_owned(),
            kind: "timeout".to_owned(),
            message: message.into(),
            hint: hint.into(),
            retryable: true,
            http_status: None,
        }
    }

    /// Something on this machine that the person named, and can fix.
    ///
    /// A path that does not exist, or a file whose bytes are not what its
    /// extension claims, is not an unknown internal fault, and telling somebody
    /// to run `memoar doctor` about it wastes their time: `doctor` inspects the
    /// install, and has nothing whatever to say about a file named on the
    /// command line.
    #[must_use]
    pub fn local(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            exit_code: EXIT_USAGE,
            code: "MEMOAR_LOCAL_FILE".to_owned(),
            kind: "local_file".to_owned(),
            message: message.into(),
            hint: hint.into(),
            retryable: false,
            http_status: None,
        }
    }

    /// A file this client wrote that no longer parses.
    ///
    /// It was `MEMOAR_UNKNOWN`, exit 9, "run memoar doctor", and `doctor`
    /// failed on the same file before checking anything. `login` rewrites both
    /// files and no longer refuses to start over a damaged one, so it is the
    /// way back, and the exit is "not initialized" because that is the state.
    #[must_use]
    pub fn damaged(path: &std::path::Path, detail: &str) -> Self {
        Self {
            exit_code: EXIT_NOT_INITIALIZED,
            code: "MEMOAR_CONFIG_DAMAGED".to_owned(),
            kind: "damaged".to_owned(),
            message: format!("{} is damaged: {detail}", path.display()),
            hint: "Run memoar login to write it again. Sources you turned off and redaction settings are lost with the file.".to_owned(),
            retryable: false,
            http_status: None,
        }
    }
    /// The same error with a different next step.
    #[must_use]
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = hint.into();
        self
    }

    #[must_use]
    pub fn locked(message: impl Into<String>) -> Self {
        Self {
            exit_code: EXIT_LOCKED,
            code: "MEMOAR_LOCKED".to_owned(),
            kind: "lock".to_owned(),
            message: message.into(),
            hint: "Resolve the competing process or native-session collision, then retry."
                .to_owned(),
            retryable: true,
            http_status: None,
        }
    }

    #[must_use]
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            exit_code: EXIT_UNKNOWN,
            code: "MEMOAR_UNKNOWN".to_owned(),
            kind: "unknown".to_owned(),
            message: message.into(),
            hint: "Run memoar doctor and retry with the latest client.".to_owned(),
            retryable: false,
            http_status: None,
        }
    }

    #[must_use]
    pub fn queue(message: impl Into<String>) -> Self {
        let message = message.into();
        if message.contains("locked") || message.contains("busy") {
            return Self::locked(message);
        }
        Self::internal(message)
    }
}

pub(crate) fn map_queue_error(error: DaemonError) -> AppError {
    // A queue file that is not a database, or is one SQLite says is broken,
    // is not an unknown fault and `doctor` cannot repair it. Saying what to
    // move aside is the whole remedy.
    let message = error.to_string();
    if message.contains("not a database") || message.contains("malformed") {
        return AppError {
            exit_code: EXIT_UNKNOWN,
            code: "MEMOAR_QUEUE_DAMAGED".to_owned(),
            kind: "damaged".to_owned(),
            message,
            hint: "Move queue.sqlite3 out of the data directory and run memoar sync again. The queue is rebuilt and sessions are captured afresh, and the archive skips what it already has.".to_owned(),
            retryable: false,
            http_status: None,
        };
    }
    AppError::queue(message)
}

pub(crate) fn map_capture_error(error: DaemonError) -> AppError {
    match error {
        DaemonError::UnsupportedRedaction(_) | DaemonError::Zip { .. } => {
            AppError::usage(error.to_string())
        }
        _ => AppError::queue(error.to_string()),
    }
}

pub(crate) fn map_sync_error(error: DaemonError) -> AppError {
    match error {
        // The archive answered: its status decides, as it does for every
        // other request this client makes. A revoked machine token was a
        // retryable network error here, and a watch retried it for ever.
        DaemonError::Http { status, ref body } => crate::http_error::http_error(status, body),
        DaemonError::Transport(_) | DaemonError::Unreachable(_) => {
            AppError::network(error.to_string())
        }
        _ => AppError::queue(error.to_string()),
    }
}

pub(crate) fn map_materialize_error(error: MaterializeError) -> AppError {
    match error {
        MaterializeError::Collision(_) => AppError::locked(error.to_string()),
        MaterializeError::UnsupportedTarget(_)
        | MaterializeError::InvalidSessionId(_)
        | MaterializeError::UnsafePath(_)
        | MaterializeError::ContractVersion(_)
        | MaterializeError::Integrity(_)
        | MaterializeError::MissingWorkspace
        | MaterializeError::Decode { .. } => AppError::usage(error.to_string()),
        _ => AppError::internal(error.to_string()),
    }
}
