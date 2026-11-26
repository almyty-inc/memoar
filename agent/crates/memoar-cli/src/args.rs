use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

pub use crate::capture_args::{PolicyArgs, SyncArgs};

#[derive(Debug, Parser)]
#[command(
    name = "memoar",
    version,
    about = "Archive and retrieve coding-agent sessions"
)]
pub struct Cli {
    /// Emit a stable JSON envelope to stdout.
    #[arg(long, global = true)]
    pub json: bool,

    /// Override the configuration directory.
    #[arg(long, global = true, env = "MEMOAR_CONFIG_DIR", hide = true)]
    pub config_dir: Option<PathBuf>,

    /// Override the local data directory.
    #[arg(long, global = true, env = "MEMOAR_DATA_DIR", hide = true)]
    pub data_dir: Option<PathBuf>,

    /// Override only the native-store discovery/materialization root.
    #[arg(long, global = true, env = "MEMOAR_CAPTURE_HOME", hide = true)]
    pub capture_home: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Sign in, register this computer, and store a capture-scoped API key.
    Login(LoginArgs),
    /// Sign this computer out: revoke its API key and delete the stored credential.
    Logout(LogoutArgs),
    /// Show this computer's configuration, queue, and detected sources. Offline.
    Status,
    /// List the session stores this agent knows, and turn them on or off.
    Sources {
        #[command(subcommand)]
        command: SourcesCommand,
    },
    /// Capture new sessions into the local queue and upload them.
    Sync(SyncArgs),
    /// Keep `sync --watch` running in the background as a per-user service.
    Service {
        #[command(subcommand)]
        command: crate::service::args::ServiceCommand,
    },
    /// Show or change what is masked before anything is hashed and uploaded.
    Redaction(RedactionArgs),
    /// Show or change how far back capture reaches, which projects it leaves
    /// out, and the free space it keeps. Offline.
    Policy(PolicyArgs),
    /// Search the archive.
    Search(SearchArgs),
    /// Read one archived session, a chunk of turns at a time.
    View(ViewArgs),
    /// Build an evidence pack for a question from the archive.
    Pack(PackArgs),
    /// Convert an archived session for another agent, and optionally write it here.
    Convert(ConvertArgs),
    /// Work with the standing instructions the agents on this account read.
    Memory {
        #[command(subcommand)]
        command: MemoryCommand,
    },
    /// Subscribe to the server command channel and materialize conversions on this machine.
    Listen(ListenArgs),
    /// Serve the archive's MCP tools over stdio, or call one from the shell.
    Mcp(crate::mcp::McpArgs),
    /// Register memoar with a coding agent: its MCP server and its skill.
    Integrate(crate::integrate::IntegrateArgs),
    /// Check the configuration, queue, credentials, and archive connection.
    Doctor,
    /// Print what this client supports, as JSON.
    Capabilities,
    /// Print the command surface and exit codes, as JSON.
    Introspect,
}

#[derive(Debug, Args)]
pub struct LoginArgs {
    /// The archive's API URL, ending in /v1.
    #[arg(long, default_value = "http://localhost:4000/v1")]
    pub endpoint: String,
    #[arg(long)]
    pub email: Option<String>,
    /// The account password. `-` reads it from standard input, which keeps it
    /// out of shell history and the process list.
    #[arg(long, env = "MEMOAR_PASSWORD", hide_env_values = true)]
    pub password: Option<String>,
    /// Existing user/API credential, used when --email is not given. A machine
    /// is still registered or verified.
    ///
    /// No clap conflict with --email: with MEMOAR_TOKEN or MEMOAR_PASSWORD
    /// exported, a conflict made the other way of signing in unusable.
    #[arg(long, env = "MEMOAR_TOKEN", hide_env_values = true)]
    pub token: Option<String>,
    /// Reuse this machine id instead of registering one. Needs --token.
    #[arg(long, requires = "token")]
    pub machine_id: Option<String>,
    /// Redact likely credentials before local snapshots are hashed and uploaded.
    #[arg(long)]
    pub redact_secrets: bool,
    /// Redact email addresses before upload.
    #[arg(long)]
    pub redact_email_addresses: bool,
    /// Redact home directory paths before upload.
    #[arg(long)]
    pub redact_home_paths: bool,
}

/// What `logout` needs. All optional: without an account credential the
/// stored key revokes itself, and where that is not possible the report says
/// where to finish the job.
#[derive(Debug, Args)]
pub struct LogoutArgs {
    /// Revoke the stored API key with this account's password. Needed only for
    /// a key stored without its id, or an archive that predates self-revocation.
    #[arg(long)]
    pub email: Option<String>,
    /// The account password. `-` reads it from standard input.
    #[arg(long, env = "MEMOAR_PASSWORD", hide_env_values = true)]
    pub password: Option<String>,
    /// An account credential allowed to revoke keys. Used when --email is not given.
    #[arg(long)]
    pub token: Option<String>,
    /// Also deregister this machine, which revokes its machine tokens.
    #[arg(long)]
    pub deregister: bool,
    /// Leave the background service installed. By default it is removed, as
    /// it cannot capture without the credential.
    #[arg(long)]
    pub keep_service: bool,
}

#[derive(Debug, Args)]
pub struct ListenArgs {
    /// Stop after handling this many commands. 0 listens until interrupted.
    #[arg(long, default_value_t = 0)]
    pub max_commands: usize,
    /// Give up if no command arrives within this window.
    #[arg(long, default_value_t = 0)]
    pub idle_timeout_seconds: u64,
}

#[derive(Debug, Subcommand)]
pub enum SourcesCommand {
    List,
    Enable { source: String },
    Disable { source: String },
}

/// What `redaction` can change, after `login` and without one.
///
/// A flag left off leaves that setting where it was, so turning one thing on
/// does not quietly turn the other two off.
#[derive(Debug, Args)]
pub struct RedactionArgs {
    /// Mask likely credentials before local snapshots are hashed and uploaded.
    #[arg(long, value_name = "BOOL")]
    pub secrets: Option<bool>,
    #[arg(long, value_name = "BOOL")]
    pub email_addresses: Option<bool>,
    #[arg(long, value_name = "BOOL")]
    pub home_paths: Option<bool>,
}

#[derive(Debug, Args)]
pub struct SearchArgs {
    pub query: String,
    #[arg(long, default_value = "hybrid")]
    pub mode: String,
    #[arg(long, default_value_t = 20)]
    pub limit: u16,
    #[arg(long)]
    pub agent: Option<String>,
    #[arg(long)]
    pub workspace: Option<String>,
}

#[derive(Debug, Args)]
pub struct ViewArgs {
    pub session_id: String,
    #[arg(long, default_value_t = 50)]
    pub chunk_size: u16,
    #[arg(long)]
    pub cursor: Option<String>,
}

#[derive(Debug, Args)]
pub struct PackArgs {
    pub query: String,
    #[arg(long, default_value_t = 4000)]
    pub max_tokens: u32,
    #[arg(long, default_value_t = 12)]
    pub max_evidence: u16,
    #[arg(long, default_value_t = 6)]
    pub max_sessions: u16,
    #[arg(long, default_value_t = 2400)]
    pub max_excerpt_chars: u32,
    #[arg(long, default_value = "mixed")]
    pub freshness_policy: String,
    #[arg(long)]
    pub stale_after_days: Option<u16>,
}

#[derive(Debug, Subcommand)]
pub enum MemoryCommand {
    /// Port the files one tool reads into another tool's dialect.
    ///
    /// The same text at the target tool's path: nothing is rewritten, no
    /// frontmatter is invented, and no model is involved.
    Convert(MemoryConvertArgs),
}

#[derive(Debug, Args)]
pub struct MemoryConvertArgs {
    /// The tool whose files are being ported.
    #[arg(long)]
    pub source: String,
    /// The dialect to write. Cursor is not one: it reads nothing from a `.mdc`
    /// without frontmatter, and inventing frontmatter is not a port.
    #[arg(long)]
    pub target: String,
    #[arg(long, default_value = "global")]
    pub scope: String,
    /// The repository whose instruction files to port, and the directory they
    /// are written into. Required for `--scope project`, and one flag rather
    /// than two because it is one thing.
    #[arg(long, value_name = "PATH")]
    pub workspace: Option<PathBuf>,
    #[arg(long)]
    pub machine_id: Option<String>,
    /// Write the ported files onto this machine. Without it the bundle is
    /// printed and nothing is touched.
    #[arg(long)]
    pub here: bool,
}

#[derive(Debug, Args)]
pub struct ConvertArgs {
    pub session_id: String,
    #[arg(long)]
    pub target: String,
    #[arg(long, default_value = "injection")]
    pub fallback: String,
    #[arg(long)]
    pub here: bool,
    /// Materialize an already downloaded native conversion bundle.
    #[arg(long, value_name = "PATH", requires = "here")]
    pub bundle: Option<PathBuf>,
    #[arg(long, default_value_t = 30)]
    pub wait_seconds: u64,
    #[arg(long, default_value_t = 250)]
    pub poll_milliseconds: u64,
}
