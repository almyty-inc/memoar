use memoar_daemon::DaemonError;
use memoar_materializer::MaterializeError;
use serde::Serialize;

pub const EXIT_OK: u8 = 0;
pub const EXIT_USAGE: u8 = 2;
pub const EXIT_NOT_INITIALIZED: u8 = 3;
pub const EXIT_NETWORK: u8 = 4;
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
        }
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
    AppError::queue(error.to_string())
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
        DaemonError::Transport(_) => AppError::network(error.to_string()),
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
        | MaterializeError::Decode { .. } => AppError::usage(error.to_string()),
        _ => AppError::internal(error.to_string()),
    }
}
