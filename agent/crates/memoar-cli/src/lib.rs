mod account;
mod api;
mod args;
mod capture_args;
mod capture_policy;
mod capture_state;
mod capture_step;
mod config;
mod convert;
mod credential;
mod dirs;
mod doctor;
mod envelope;
mod error;
mod health;
mod http_error;
mod listen;
mod lock;
mod login;
mod logout;
mod machine;
mod memory;
mod plan_report;
mod progress;
mod query;
mod revoke;
mod service;
mod settings;
mod sse;
mod status;
mod sync;
mod sync_archive;
mod watch;

#[cfg(test)]
mod tests;

pub use crate::api::{
    BASE64_EXPANSION_DENOMINATOR, BASE64_EXPANSION_NUMERATOR, DOWNLOAD_TIMEOUT,
    MAX_CONVERSION_BUNDLE_BYTES, SLOWEST_TOLERATED_BYTES_PER_SEC,
};
pub use crate::args::{
    Cli, Command, ConvertArgs, ListenArgs, LoginArgs, LogoutArgs, MemoryCommand, MemoryConvertArgs,
    PackArgs, PolicyArgs, RedactionArgs, SearchArgs, SourcesCommand, SyncArgs, ViewArgs,
};
pub use crate::config::RuntimePaths;
pub use crate::credential::{Credential, CredentialStore, FileCredentialStore};
pub use crate::envelope::{
    ROBOT_ENVELOPE_VERSION, capabilities_value, error_envelope, introspect_value, success_envelope,
};
pub use crate::error::{
    AppError, EXIT_DISK_LOW, EXIT_LOCKED, EXIT_NETWORK, EXIT_NOT_INITIALIZED, EXIT_OK,
    EXIT_REFUSED, EXIT_UNKNOWN, EXIT_USAGE,
};
pub use crate::service::args::{
    ServiceChangeArgs, ServiceCommand, ServiceLogsArgs, ServiceNameArgs,
};
pub use crate::sse::{ServerEvent, SseDecoder};

use serde::Serialize;
use serde_json::Value;

use crate::convert::convert;
use crate::doctor::doctor;
use crate::listen::listen;
use crate::login::login;
use crate::logout::logout;
use crate::memory::memory;
use crate::query::{pack, search, view};
use crate::settings::{redaction, sources};
use crate::status::status;
use crate::sync::sync;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub command: String,
    pub data: Value,
}

pub fn execute(cli: &Cli, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    match &cli.command {
        Command::Login(args) => login(args, paths),
        Command::Logout(args) => logout(args, paths),
        Command::Status => status(paths),
        Command::Service { command } => crate::service::service(command, paths, cli.json),
        Command::Sources { command } => sources(command, paths),
        Command::Sync(args) => sync(args, cli.json, paths),
        Command::Redaction(args) => redaction(args, paths),
        Command::Policy(args) => crate::capture_policy::policy(args, paths),
        Command::Search(args) => search(args, paths),
        Command::View(args) => view(args, paths),
        Command::Pack(args) => pack(args, paths),
        Command::Convert(args) => convert(args, paths),
        Command::Memory { command } => memory(command, paths),
        Command::Listen(args) => listen(args, paths),
        Command::Doctor => doctor(paths),
        Command::Capabilities => Ok(CommandOutput {
            command: "capabilities".to_owned(),
            data: capabilities_value(),
        }),
        Command::Introspect => Ok(CommandOutput {
            command: "introspect".to_owned(),
            data: introspect_value(),
        }),
    }
}
