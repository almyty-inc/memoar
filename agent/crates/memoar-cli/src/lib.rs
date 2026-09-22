mod api;
mod args;
mod config;
mod convert;
mod credential;
mod doctor;
mod envelope;
mod error;
mod listen;
mod login;
mod machine;
mod memory;
mod query;
mod settings;
mod sse;
mod status;
mod sync;
mod watch;

#[cfg(test)]
mod tests;

pub use crate::api::{
    BASE64_EXPANSION_DENOMINATOR, BASE64_EXPANSION_NUMERATOR, DOWNLOAD_TIMEOUT,
    MAX_CONVERSION_BUNDLE_BYTES, SLOWEST_TOLERATED_BYTES_PER_SEC,
};
pub use crate::args::{
    Cli, Command, ConvertArgs, ListenArgs, LoginArgs, MemoryCommand, MemoryConvertArgs, PackArgs,
    RedactionArgs, SearchArgs, SourcesCommand, SyncArgs, ViewArgs,
};
pub use crate::config::RuntimePaths;
pub use crate::credential::{Credential, CredentialStore, FileCredentialStore};
pub use crate::envelope::{
    ROBOT_ENVELOPE_VERSION, capabilities_value, error_envelope, introspect_value, success_envelope,
};
pub use crate::error::{
    AppError, EXIT_LOCKED, EXIT_NETWORK, EXIT_NOT_INITIALIZED, EXIT_OK, EXIT_REFUSED, EXIT_UNKNOWN,
    EXIT_USAGE,
};
pub use crate::sse::{ServerEvent, SseDecoder};

use serde::Serialize;
use serde_json::Value;

use crate::convert::convert;
use crate::doctor::doctor;
use crate::listen::listen;
use crate::login::login;
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
        Command::Status => status(paths),
        Command::Sources { command } => sources(command, paths),
        Command::Sync(args) => sync(args, cli.json, paths),
        Command::Redaction(args) => redaction(args, paths),
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
