use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

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
    Login(LoginArgs),
    Status,
    Sources {
        #[command(subcommand)]
        command: SourcesCommand,
    },
    Sync(SyncArgs),
    /// Show or change what is masked before anything is hashed and uploaded.
    Redaction(RedactionArgs),
    Search(SearchArgs),
    View(ViewArgs),
    Pack(PackArgs),
    Convert(ConvertArgs),
    /// Subscribe to the server command channel and materialize conversions on this machine.
    Listen(ListenArgs),
    Doctor,
    Capabilities,
    Introspect,
}

#[derive(Debug, Args)]
pub struct LoginArgs {
    #[arg(long, default_value = "http://localhost:4000/v1")]
    pub endpoint: String,
    #[arg(long)]
    pub email: Option<String>,
    #[arg(long)]
    pub password: Option<String>,
    /// Existing user/API credential. A machine is still registered or verified.
    #[arg(long, env = "MEMOAR_TOKEN", conflicts_with_all = ["email", "password"])]
    pub token: Option<String>,
    #[arg(long, requires = "token")]
    pub machine_id: Option<String>,
    /// Redact likely credentials before local snapshots are hashed and uploaded.
    #[arg(long)]
    pub redact_secrets: bool,
    #[arg(long)]
    pub redact_email_addresses: bool,
    #[arg(long)]
    pub redact_home_paths: bool,
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

#[derive(Debug, Args)]
pub struct SyncArgs {
    /// Keep polling native stores after the first sync.
    #[arg(long)]
    pub watch: bool,
    #[arg(long, default_value_t = 2)]
    pub interval_seconds: u64,
    #[arg(long, default_value_t = 2)]
    pub debounce_seconds: u64,
    /// Stop watching after this many completed sync cycles. 0 watches until
    /// interrupted, which is what a person running this wants; a finite count
    /// is how the retry behaviour is exercised without an infinite loop.
    #[arg(long, default_value_t = 0, hide = true)]
    pub max_cycles: usize,
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
