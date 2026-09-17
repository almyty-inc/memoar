use chrono::Utc;
use clap::{Args, Parser, Subcommand};
use memoar_connectors::{OperatingSystem, SOURCES, discover};
use memoar_daemon::{
    CaptureSummary, DaemonError, HttpTransport, OfflineQueue, PollingCapture, RedactionConfig,
    SyncEngine, capture_sources_with_redaction, memory::MemorySync,
};
use memoar_materializer::{ConversionBundle, MaterializeError, Target, materialize_bundle};
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Read as _;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use uuid::Uuid;

pub const EXIT_OK: u8 = 0;
pub const EXIT_USAGE: u8 = 2;
pub const EXIT_NOT_INITIALIZED: u8 = 3;
pub const EXIT_NETWORK: u8 = 4;
pub const EXIT_LOCKED: u8 = 7;
pub const EXIT_UNKNOWN: u8 = 9;
pub const ROBOT_ENVELOPE_VERSION: &str = "1";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    contract_version: String,
    endpoint: String,
    machine_id: String,
    disabled_sources: BTreeSet<String>,
    #[serde(default)]
    redaction: RedactionConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    /// A long-lived, revocable API key scoped to what the agent actually does.
    /// What `login` mints and stores now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    /// A user access token. What older installs stored, and what `--token`
    /// accepts when it is handed one. It expires in an hour, which is why it is
    /// no longer what `login` writes.
    #[serde(default)]
    access_token: String,
}

/// How the agent proves who it is.
///
/// `login` used to store the browser access token, which the server issues with
/// a one-hour lifetime and no refresh. Every command then depended on it, so
/// `sync --watch` — a command whose entire purpose is to keep running —
/// stopped working after an hour and could only be revived by typing a
/// password again. An API key has no expiry, is revocable from the account, and
/// carries only the scopes the agent needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credential {
    ApiKey(String),
    Bearer(String),
}

/// The prefix the server puts on every API key it mints, which is what lets a
/// secret handed to `--token` be classified without asking the user which kind
/// they pasted.
const API_KEY_PREFIX: &str = "memoar_";

impl Credential {
    fn classify(secret: &str) -> Self {
        if secret.starts_with(API_KEY_PREFIX) {
            Self::ApiKey(secret.to_owned())
        } else {
            Self::Bearer(secret.to_owned())
        }
    }

    fn secret(&self) -> &str {
        match self {
            Self::ApiKey(secret) | Self::Bearer(secret) => secret,
        }
    }
}

/// The scopes `login` asks for, and no others.
///
/// Deliberately short of what a browser token carries: no `sharing:write`, no
/// `keys:write`, no `mcp:use`. The agent captures, uploads, keeps its machine
/// record current, and reads back what it archived. It has never needed the
/// power to share a session, mint another credential, or act as an MCP client,
/// and a credential that sits on a laptop indefinitely should not hold rights
/// nothing on that laptop exercises.
const CAPTURE_SCOPES: [&str; 5] = [
    "archive:read",
    "archive:write",
    "ingest:write",
    "machines:write",
    "materialize:read",
];

pub trait CredentialStore {
    fn load(&self) -> Result<Option<Credential>, AppError>;
    fn store(&self, credential: &Credential) -> Result<(), AppError>;
}

#[derive(Debug, Clone)]
pub struct FileCredentialStore {
    path: PathBuf,
}

impl FileCredentialStore {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl CredentialStore for FileCredentialStore {
    /// An API key wins over an access token when both are present, which is what
    /// an install written before the key existed looks like after its next
    /// `login`. The old token is left in place rather than deleted so that
    /// rolling back to an older agent does not lock the machine out.
    fn load(&self) -> Result<Option<Credential>, AppError> {
        if !self.path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&self.path).map_err(|error| {
            AppError::internal(format!("could not read {}: {error}", self.path.display()))
        })?;
        let credentials: Credentials = serde_json::from_slice(&bytes).map_err(|error| {
            AppError::internal(format!(
                "invalid credentials {}: {error}",
                self.path.display()
            ))
        })?;
        if let Some(key) = credentials.api_key.filter(|key| !key.is_empty()) {
            return Ok(Some(Credential::ApiKey(key)));
        }
        if credentials.access_token.is_empty() {
            return Ok(None);
        }
        Ok(Some(Credential::Bearer(credentials.access_token)))
    }

    fn store(&self, credential: &Credential) -> Result<(), AppError> {
        if credential.secret().is_empty() {
            return Err(AppError::usage("credential cannot be empty"));
        }
        let credentials = match credential {
            Credential::ApiKey(secret) => Credentials {
                api_key: Some(secret.clone()),
                access_token: String::new(),
            },
            Credential::Bearer(secret) => Credentials {
                api_key: None,
                access_token: secret.clone(),
            },
        };
        let bytes = serde_json::to_vec(&credentials)
            .map_err(|error| AppError::internal(error.to_string()))?;
        atomic_replace(&self.path, &bytes, 0o600)
    }
}

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub home: PathBuf,
}

impl RuntimePaths {
    pub fn resolve(cli: &Cli) -> Result<Self, AppError> {
        let user_home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(AppError::not_initialized)?;
        let home = cli
            .capture_home
            .clone()
            .unwrap_or_else(|| user_home.clone());
        let config_dir = cli
            .config_dir
            .clone()
            .unwrap_or_else(|| user_home.join(".config/memoar"));
        let data_dir = cli
            .data_dir
            .clone()
            .unwrap_or_else(|| user_home.join(".local/share/memoar"));
        Ok(Self {
            config_dir,
            data_dir,
            home,
        })
    }

    fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.json")
    }

    fn credentials_file(&self) -> PathBuf {
        self.config_dir.join("credentials.json")
    }

    fn queue_file(&self) -> PathBuf {
        self.data_dir.join("queue.sqlite3")
    }

    fn credential_store(&self) -> FileCredentialStore {
        FileCredentialStore::new(self.credentials_file())
    }
}

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

fn login(args: &LoginArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    if args.endpoint.trim().is_empty() {
        return Err(AppError::usage("--endpoint cannot be empty"));
    }
    let endpoint = args.endpoint.trim_end_matches('/');
    let unauthenticated = ApiClient::new(endpoint, None);
    // What the user handed us, or what a password buys: either way it is only
    // good enough to register the machine and mint the credential that lasts.
    let account =
        if let Some(token) = &args.token {
            if token.is_empty() {
                return Err(AppError::usage("--token cannot be empty"));
            }
            Credential::classify(token)
        } else {
            let email = args.email.as_ref().ok_or_else(|| {
                AppError::usage("login requires --email and --password, or --token")
            })?;
            let password = args.password.as_ref().ok_or_else(|| {
                AppError::usage("login requires --email and --password, or --token")
            })?;
            let auth = unauthenticated.post(
                "/auth/login",
                &json!({ "email": email, "password": password }),
            )?;
            Credential::Bearer(
                auth.get("accessToken")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AppError::network("login response did not include accessToken"))?
                    .to_owned(),
            )
        };
    let api = ApiClient::new(endpoint, Some(&account));
    let machine_id = if let Some(machine_id) = &args.machine_id {
        verify_machine(&api, machine_id)?;
        machine_id.clone()
    } else {
        let machine = api.post(
            "/machines",
            &json!({
                "name": machine_name(),
                "platform": std::env::consts::OS,
                "agentVersion": env!("CARGO_PKG_VERSION")
            }),
        )?;
        machine
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::network("machine registration response did not include id"))?
            .to_owned()
    };
    validate_uuid_v7("machine id", &machine_id)?;
    let config = Config {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        endpoint: endpoint.to_owned(),
        machine_id: machine_id.clone(),
        disabled_sources: BTreeSet::new(),
        redaction: RedactionConfig {
            secrets: args.redact_secrets,
            email_addresses: args.redact_email_addresses,
            home_paths: args.redact_home_paths,
        },
    };
    patch_machine_state(&api, &config, paths)?;
    // A password or a browser token gets us this far and no further: what is
    // stored is a capture-scoped key that does not expire, so no later command
    // depends on a credential with an hour to live.
    let credential = match &account {
        Credential::ApiKey(_) => account.clone(),
        Credential::Bearer(_) => mint_capture_key(&api, &machine_name())?,
    };
    paths.credential_store().store(&credential)?;
    save_config(paths, &config)?;
    OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    Ok(CommandOutput {
        command: "login".to_owned(),
        data: json!({
            "initialized": true,
            "endpoint": config.endpoint,
            "machineId": machine_id,
            "credential": match credential { Credential::ApiKey(_) => "api-key", Credential::Bearer(_) => "access-token" },
            "redaction": config.redaction
        }),
    })
}

/// Trades the account credential for a long-lived one scoped to capture.
///
/// This is the whole point of the change. `login` used to keep the browser
/// access token, which the server issues for one hour with no refresh, so every
/// later command was living on a credential that had usually already died —
/// `sync --watch`, whose entire job is to keep running, could not survive its
/// own first hour.
///
/// Named after the machine so a key is recognisable in the account's key list
/// and can be revoked for one laptop without touching the others.
fn mint_capture_key(api: &ApiClient, machine_name: &str) -> Result<Credential, AppError> {
    let response = api.post(
        "/auth/api-keys",
        &json!({ "name": format!("memoar agent · {machine_name}"), "scopes": CAPTURE_SCOPES }),
    )?;
    let secret = response
        .get("secret")
        .and_then(Value::as_str)
        .filter(|secret| !secret.is_empty())
        .ok_or_else(|| AppError::network("API key response did not include secret"))?;
    Ok(Credential::classify(secret))
}

fn status(paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let config = load_config(paths)?;
    let credential = load_credential(paths)?;
    let queue = OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    let counts = queue.counts().map_err(map_queue_error)?;
    let discovered = discover(&paths.home, OperatingSystem::current());
    Ok(CommandOutput {
        command: "status".to_owned(),
        data: json!({
            "initialized": true,
            "credentialsConfigured": !credential.secret().is_empty(),
            "endpoint": config.endpoint,
            "machineId": config.machine_id,
            "queue": counts,
            "redaction": config.redaction,
            "detectedSources": discovered.iter().filter(|source| source.detected).count(),
            "sourceCount": discovered.len(),
            // Detected and readable are not the same thing, and this used to
            // report only the first. See `skipped_symlinks`.
            "skippedSymlinks": skipped_symlinks(&paths.home)
        }),
    })
}

/// How deep the symlink scan looks below a source's root.
///
/// The root itself and the directories directly under it, which is where the
/// two shapes that actually lose files live: a linked `~/.claude/projects`, and
/// a linked project directory inside a real one. Not the whole tree, because
/// `status` is polled every few seconds by the desktop app and walking every
/// session store on every poll would cost more than the answer is worth.
const SYMLINK_SCAN_DEPTH: u8 = 2;

/// The symlinks discovery walks past without a word, per source.
///
/// Discovery skips any entry that is a symlink, and says nothing about having
/// done it, while `detected` is answered by `Path::exists`, which follows them.
/// So a `~/.claude/projects` linked to an external volume is reported as a
/// detected source, captures nothing at all, and neither `sync` nor `doctor`
/// ever says why. Nothing here changes what is captured — the skipping belongs
/// to `memoar-connectors` — but the agent stops claiming a source it is not
/// reading.
fn skipped_symlinks(home: &Path) -> Vec<Value> {
    let mut reports = Vec::new();
    for source in discover(home, OperatingSystem::current()) {
        let mut links = Vec::new();
        for pattern in &source.paths {
            collect_skipped_symlinks(&literal_root(pattern), 0, &mut links);
        }
        links.sort();
        links.dedup();
        reports.extend(links.into_iter().map(|path| {
            json!({
                "source": source.id,
                "path": path,
                "detail": "a symlink: discovery does not follow it, so nothing under it is captured"
            })
        }));
    }
    reports
}

fn collect_skipped_symlinks(path: &Path, depth: u8, found: &mut Vec<PathBuf>) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() {
        found.push(path.to_path_buf());
        return;
    }
    if depth >= SYMLINK_SCAN_DEPTH || !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        collect_skipped_symlinks(&entry.path(), depth + 1, found);
    }
}

/// The part of a declared pattern that is a real path, which is the directory
/// discovery starts its walk from. The same cut `memoar-connectors` makes.
fn literal_root(pattern: &Path) -> PathBuf {
    let mut root = PathBuf::new();
    for component in pattern.components() {
        let text = component.as_os_str().to_string_lossy();
        if text.contains('*') || text.contains('<') || text.contains('{') {
            break;
        }
        root.push(component);
    }
    root
}

fn sources(command: &SourcesCommand, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    match command {
        SourcesCommand::List => {
            let config = load_config_optional(paths)?;
            let disabled = config
                .as_ref()
                .map(|config| &config.disabled_sources)
                .cloned()
                .unwrap_or_default();
            let items: Vec<_> = discover(&paths.home, OperatingSystem::current())
                .into_iter()
                .map(|source| {
                    json!({
                        "id": source.id,
                        "displayName": source.display_name,
                        "tier": source.tier,
                        "format": source.format,
                        "stability": source.stability,
                        "paths": source.paths,
                        "detected": source.detected,
                        "enabled": !disabled.contains(source.id)
                    })
                })
                .collect();
            Ok(CommandOutput {
                command: "sources.list".to_owned(),
                data: json!({ "items": items }),
            })
        }
        SourcesCommand::Enable { source } => update_source(paths, source, true),
        SourcesCommand::Disable { source } => update_source(paths, source, false),
    }
}

fn update_source(
    paths: &RuntimePaths,
    source: &str,
    enabled: bool,
) -> Result<CommandOutput, AppError> {
    if !SOURCES.iter().any(|item| item.id == source) {
        return Err(AppError::usage(format!("unknown source: {source}")));
    }
    let mut config = load_config(paths)?;
    if enabled {
        config.disabled_sources.remove(source);
    } else {
        config.disabled_sources.insert(source.to_owned());
    }
    save_config(paths, &config)?;
    let token = load_credential(paths)?;
    patch_machine_state(
        &ApiClient::new(&config.endpoint, Some(&token)),
        &config,
        paths,
    )?;
    Ok(CommandOutput {
        command: if enabled {
            "sources.enable"
        } else {
            "sources.disable"
        }
        .to_owned(),
        data: json!({ "source": source, "enabled": enabled }),
    })
}

fn sync(args: &SyncArgs, json_mode: bool, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    if args.watch && json_mode {
        return Err(AppError::usage("--watch cannot be combined with --json"));
    }
    let config = load_config(paths)?;
    let credential = load_credential(paths)?;
    let queue = OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    let enabled = enabled_sources(&config);
    let captured = capture_sources_with_redaction(
        &queue,
        &paths.home,
        OperatingSystem::current(),
        &enabled,
        config.redaction,
    )
    .map_err(map_capture_error)?;
    let mut sweep = Sweep {
        queue: &queue,
        config: &config,
        credential: &credential,
        paths,
        enabled,
        // One sweep for the life of the command. It remembers which instruction
        // files it has already sent, and a fresh one each cycle remembers
        // nothing — which, now that a watch survives its own failures, is every
        // instruction file on the machine re-uploaded every interval for as
        // long as the laptop is on.
        memory: MemorySync::with_redaction(config.redaction),
    };
    if args.watch {
        return watch(args, &mut sweep, captured);
    }
    let last = sync_pending(&mut sweep, captured)?;
    Ok(CommandOutput {
        command: "sync".to_owned(),
        data: last,
    })
}

/// What every cycle of a sync needs, assembled once.
///
/// Gathered into one value because a watch hands the same things to every
/// cycle, and because the memory sweep in particular has to be the same one
/// each time: it is what remembers which instruction files have not changed.
struct Sweep<'a> {
    queue: &'a OfflineQueue,
    config: &'a Config,
    credential: &'a Credential,
    paths: &'a RuntimePaths,
    enabled: HashSet<String>,
    memory: MemorySync,
}

/// How long a watch waits after a failure it expects to outlive.
///
/// The first retry is one poll interval — the watcher is already prepared to
/// wait that long — and doubles from there so an archive that is down for an
/// afternoon is asked about every five minutes rather than every two seconds.
const WATCH_BACKOFF_CEILING: Duration = Duration::from_secs(300);

/// Losing the network must not end a watch.
///
/// `sync --watch` exists to ride out being offline: the queue holds what was
/// captured until the archive is reachable again. Propagating the first
/// transport error out of the loop ended the process instead, so closing a lid
/// or changing wifi killed the watcher, and everything captured afterwards sat
/// on the laptop with nothing running to send it. The whole point of the
/// offline queue was a thing the watcher itself could not survive.
///
/// What still ends a watch is a condition repeating cannot fix: a credential
/// the archive refuses, a queue that will not open, a redaction setting no
/// capture can satisfy. See `fatal_for_watch`.
fn watch(
    args: &SyncArgs,
    sweep: &mut Sweep,
    first: CaptureSummary,
) -> Result<CommandOutput, AppError> {
    let interval = Duration::from_secs(args.interval_seconds.max(1));
    let mut watcher = PollingCapture::new(Duration::from_secs(args.debounce_seconds.max(1)));
    let mut backoff = interval;
    let mut captured = first;
    let mut completed = 0_usize;
    let mut last = json!({});
    loop {
        match sync_pending(sweep, captured) {
            Ok(report) => {
                println!(
                    "captured {} artifacts, uploaded {}",
                    report["captured"], report["sync"]["uploaded"]
                );
                last = report;
                backoff = interval;
                completed += 1;
                if args.max_cycles > 0 && completed >= args.max_cycles {
                    return Ok(CommandOutput {
                        command: "sync".to_owned(),
                        data: last,
                    });
                }
                thread::sleep(interval);
            }
            Err(error) => {
                retry_or_give_up(&error, &mut backoff)?;
            }
        }
        captured = match watcher.scan(
            sweep.queue,
            &sweep.paths.home,
            OperatingSystem::current(),
            &sweep.enabled,
            sweep.config.redaction,
            SystemTime::now(),
        ) {
            Ok(captured) => CaptureSummary {
                captured,
                skipped: Vec::new(),
            },
            Err(error) => {
                retry_or_give_up(&map_capture_error(error), &mut backoff)?;
                CaptureSummary {
                    captured: 0,
                    skipped: Vec::new(),
                }
            }
        };
    }
}

/// Waits out a failure a watch expects to outlive, or hands back the one it
/// does not. Sleeping here — rather than at the top of the loop — is what keeps
/// an unreachable archive from being asked again immediately, forever.
fn retry_or_give_up(error: &AppError, backoff: &mut Duration) -> Result<(), AppError> {
    if fatal_for_watch(error) {
        return Err(error.clone());
    }
    eprintln!(
        "memoar: {} — retrying in {}s",
        error.message,
        backoff.as_secs()
    );
    thread::sleep(*backoff);
    *backoff = (*backoff * 2).min(WATCH_BACKOFF_CEILING);
    Ok(())
}

/// Which failures a watch cannot outlive.
///
/// Retryable is the error's own word for it — a network error or a queue
/// another process is holding will plausibly work on the next pass — with one
/// exception that word gets wrong. A 401 or 403 is delivered as a network
/// error, but the credential `login` stores does not expire: the archive is
/// saying revoked or not permitted, and asking again every five minutes until
/// somebody notices is worse than stopping and saying so.
fn fatal_for_watch(error: &AppError) -> bool {
    !error.retryable || refused_credentials(&error.message)
}

fn refused_credentials(message: &str) -> bool {
    message.ends_with("(HTTP 401)") || message.ends_with("(HTTP 403)")
}

/// Reads, and changes, what is masked before upload.
///
/// `login` was the only place redaction was ever written. Somebody who forgot
/// the flags had to delete their configuration and sign in again to add them,
/// and the desktop app — the path somebody who does not use a terminal takes —
/// passed all three as false with nothing anywhere to change them. A setting
/// that can only be chosen once, before you have seen what gets uploaded, is
/// not a setting.
///
/// Deliberately local and offline: turning masking on is exactly what somebody
/// does after noticing something they did not want sent, and that must not
/// depend on the archive being reachable. It applies from the next capture;
/// what has already been uploaded is already uploaded.
fn redaction(args: &RedactionArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let mut config = load_config(paths)?;
    let before = config.redaction;
    if let Some(secrets) = args.secrets {
        config.redaction.secrets = secrets;
    }
    if let Some(email_addresses) = args.email_addresses {
        config.redaction.email_addresses = email_addresses;
    }
    if let Some(home_paths) = args.home_paths {
        config.redaction.home_paths = home_paths;
    }
    // `RedactionConfig` is the daemon's type and does not compare, so the
    // three settings are compared by hand rather than saving a file that did
    // not change.
    let changed = config.redaction.secrets != before.secrets
        || config.redaction.email_addresses != before.email_addresses
        || config.redaction.home_paths != before.home_paths;
    if changed {
        save_config(paths, &config)?;
    }
    Ok(CommandOutput {
        command: "redaction".to_owned(),
        data: json!({
            "redaction": config.redaction,
            "changed": changed,
            "appliesFrom": "the next capture"
        }),
    })
}

fn enabled_sources(config: &Config) -> HashSet<String> {
    SOURCES
        .iter()
        .filter(|source| !config.disabled_sources.contains(source.id))
        .map(|source| source.id.to_owned())
        .collect()
}

fn sync_pending(sweep: &mut Sweep, captured: CaptureSummary) -> Result<Value, AppError> {
    let Sweep {
        queue,
        config,
        credential,
        paths,
        ..
    } = *sweep;
    let api = ApiClient::new(&config.endpoint, Some(credential));
    patch_machine_state(&api, config, paths)?;
    let (token, expires_at) = issue_machine_token(&api, &config.machine_id)?;
    let report = SyncEngine::new(capture_transport(
        config,
        credential,
        &token,
        expires_at.as_deref(),
    ))
    .sync(queue, &config.machine_id)
    .map_err(map_sync_error)?;
    // The instruction files the agents on this machine read, for the projects
    // this account already has sessions in. They are not transcripts and do not
    // go through the queue: what matters is whether the text changed.
    // With the redaction the user asked for. It was applied to transcripts and
    // not to these — so somebody who ran `memoar login --redact-secrets` had
    // their sessions scrubbed and their `~/.claude/CLAUDE.md`, every project
    // `AGENTS.md` and every `~/.claude/projects/*/memory/*.md` uploaded byte for
    // byte, which are the files a connection string actually gets pasted into.
    // The sweep is handed in rather than built here so its "this file has not
    // changed" cache survives a watch cycle; building a new one each pass
    // re-uploaded every instruction file on this machine every interval.
    let memory = sweep.memory.run(
        &capture_transport(config, credential, &token, expires_at.as_deref()),
        &paths.home,
        &archived_workspaces(&api, &paths.home),
        &config.machine_id,
        &Utc::now().to_rfc3339(),
    );
    // `skipped` is named, not just counted: a file redaction could not be
    // applied to stays on this machine, and you are entitled to know which.
    //
    // `memoryRefused` is the same thing for instruction files, and is a count
    // rather than a list because the report the daemon returns carries only a
    // number. It sits here, beside `skipped`, rather than buried in the memory
    // block: a file that stayed behind is not a detail. Naming them needs
    // `MemoryReport` to carry the paths, which is the daemon's to change.
    Ok(json!({
        "captured": captured.captured,
        "skipped": captured.skipped.iter().map(|path| path.display().to_string()).collect::<Vec<_>>(),
        "memoryRefused": memory.refused,
        "sync": report,
        "memory": memory,
    }))
}

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
fn archived_workspaces(api: &ApiClient, home: &Path) -> Vec<PathBuf> {
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

fn search(args: &SearchArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    if !matches!(args.mode.as_str(), "hybrid" | "lexical" | "semantic") {
        return Err(AppError::usage(
            "--mode must be hybrid, lexical, or semantic",
        ));
    }
    let (config, token) = authenticated_config(paths)?;
    let mut query = vec![
        ("q", args.query.clone()),
        ("mode", args.mode.clone()),
        ("limit", args.limit.to_string()),
    ];
    if let Some(agent) = &args.agent {
        query.push(("agent", agent.clone()));
    }
    if let Some(workspace) = &args.workspace {
        query.push(("workspace", workspace.clone()));
    }
    let data = ApiClient::new(&config.endpoint, Some(&token)).get_query("/search", &query)?;
    Ok(CommandOutput {
        command: "search".to_owned(),
        data,
    })
}

fn view(args: &ViewArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let (config, token) = authenticated_config(paths)?;
    let mut query = vec![("chunkSize", args.chunk_size.to_string())];
    if let Some(cursor) = &args.cursor {
        query.push(("cursor", cursor.clone()));
    }
    let data = ApiClient::new(&config.endpoint, Some(&token))
        .get_query(&format!("/sessions/{}", args.session_id), &query)?;
    Ok(CommandOutput {
        command: "view".to_owned(),
        data,
    })
}

fn pack(args: &PackArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    if !matches!(args.freshness_policy.as_str(), "strict" | "mixed") {
        return Err(AppError::usage(
            "--freshness-policy must be strict or mixed",
        ));
    }
    let (config, token) = authenticated_config(paths)?;
    let mut request = json!({
        "query": args.query,
        "maxTokens": args.max_tokens,
        "maxEvidence": args.max_evidence,
        "maxSessions": args.max_sessions,
        "maxExcerptChars": args.max_excerpt_chars,
        "freshnessPolicy": args.freshness_policy
    });
    if let Some(days) = args.stale_after_days {
        request["staleAfterDays"] = json!(days);
    }
    let data = ApiClient::new(&config.endpoint, Some(&token)).post("/pack", &request)?;
    Ok(CommandOutput {
        command: "pack".to_owned(),
        data,
    })
}

fn convert(args: &ConvertArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    if !matches!(args.fallback.as_str(), "fail" | "injection") {
        return Err(AppError::usage("--fallback must be fail or injection"));
    }
    let native_target = Target::from_str(&args.target);
    if args.here && native_target.is_err() {
        return Err(AppError::usage(
            "--here requires target claude-code, codex, or antigravity-cli",
        ));
    }
    if args.fallback == "fail" && native_target.is_err() {
        return Err(AppError::usage(
            "unknown native target requires --fallback injection",
        ));
    }
    if let Some(bundle_path) = &args.bundle {
        let target = native_target.map_err(|error| AppError::usage(error.to_string()))?;
        let bundle_bytes = fs::read(bundle_path).map_err(|error| {
            AppError::internal(format!("could not read {}: {error}", bundle_path.display()))
        })?;
        let bundle: ConversionBundle = serde_json::from_slice(&bundle_bytes)
            .map_err(|error| AppError::internal(format!("invalid conversion bundle: {error}")))?;
        if bundle.target != target || bundle.session_id != args.session_id {
            return Err(AppError::usage(
                "bundle target or session id does not match the command",
            ));
        }
        return materialize_conversion(bundle, paths);
    }
    let (config, token) = authenticated_config(paths)?;
    let api = ApiClient::new(&config.endpoint, Some(&token));
    let mut job = api.post(
        "/convert",
        &json!({
            "sessionId": args.session_id,
            "target": args.target,
            "fallback": args.fallback
        }),
    )?;
    if !args.here {
        return Ok(CommandOutput {
            command: "convert".to_owned(),
            data: job,
        });
    }
    let job_id = job
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::network("conversion response did not include id"))?
        .to_owned();
    let deadline = Instant::now() + Duration::from_secs(args.wait_seconds.max(1));
    loop {
        match job.get("status").and_then(Value::as_str) {
            Some("ready") => break,
            Some("failed") => {
                return Err(AppError::network(format!(
                    "conversion failed: {}",
                    job.get("report").cloned().unwrap_or(Value::Null)
                )));
            }
            _ if Instant::now() >= deadline => {
                return Err(AppError::network(
                    "conversion did not become ready before timeout",
                ));
            }
            _ => {
                thread::sleep(Duration::from_millis(args.poll_milliseconds.max(25)));
                job = api.get(&format!("/convert/{job_id}"))?;
            }
        }
    }
    let bundle = api.download_conversion(&format!("/convert/{job_id}/download"))?;
    if bundle.session_id != args.session_id || bundle.target != native_target.unwrap() {
        return Err(AppError::network(
            "downloaded bundle target or session id did not match the job",
        ));
    }
    materialize_conversion(bundle, paths)
}

/// Subscribes to this machine's durable command channel and materializes
/// conversion bundles as the server pushes them.
///
/// Commands are acknowledged only after materialization succeeds, so a crash
/// mid-materialize leaves the command unacked and the server replays it on the
/// next connection. Failures are acked with their reason so an operator can see
/// why a machine could not apply a bundle.
fn listen(args: &ListenArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let (config, token) = authenticated_config(paths)?;
    let api = ApiClient::new(&config.endpoint, Some(&token));
    let (machine_token, _) = issue_machine_token(&api, &config.machine_id)?;
    let machine_api = ApiClient::new(
        &config.endpoint,
        Some(&Credential::Bearer(machine_token.clone())),
    );

    let response = machine_api
        .authorize(
            machine_api
                .client
                .get(machine_api.url(&format!("/machines/{}/commands/stream", config.machine_id))),
        )
        .header("accept", "text/event-stream")
        .send()
        .map_err(|error| AppError::network(format!("command stream failed: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::network(format!(
            "command stream rejected with status {}",
            response.status()
        )));
    }

    let mut stream = response;
    let mut decoder = SseDecoder::new();
    let mut handled: Vec<Value> = Vec::new();
    let mut chunk = [0_u8; 8192];
    let idle_deadline = (args.idle_timeout_seconds > 0)
        .then(|| Instant::now() + Duration::from_secs(args.idle_timeout_seconds));

    loop {
        if let Some(deadline) = idle_deadline {
            if Instant::now() >= deadline {
                break;
            }
        }
        let read = stream
            .read(&mut chunk)
            .map_err(|error| AppError::network(format!("command stream ended: {error}")))?;
        if read == 0 {
            break;
        }
        let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
        for event in decoder.push(&text) {
            if event.event != "command" {
                continue;
            }
            let command: Value = serde_json::from_str(&event.data)
                .map_err(|error| AppError::network(format!("invalid command payload: {error}")))?;
            handled.push(apply_command(&machine_api, &config, paths, &command)?);
            if args.max_commands > 0 && handled.len() >= args.max_commands {
                return Ok(CommandOutput {
                    command: "listen".to_owned(),
                    data: json!({ "handled": handled }),
                });
            }
        }
    }
    Ok(CommandOutput {
        command: "listen".to_owned(),
        data: json!({ "handled": handled }),
    })
}

/// Applies one server command and acknowledges its outcome.
fn apply_command(
    machine_api: &ApiClient,
    config: &Config,
    paths: &RuntimePaths,
    command: &Value,
) -> Result<Value, AppError> {
    let command_id = command
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::network("command did not include an id"))?;
    let kind = command
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = command.get("payload").cloned().unwrap_or(Value::Null);

    let outcome = match kind {
        "materialize" => materialize_from_command(paths, &payload),
        other => Err(AppError::usage(format!(
            "unsupported command kind: {other}"
        ))),
    };

    let ack = match &outcome {
        Ok(_) => json!({ "status": "completed" }),
        Err(error) => json!({ "status": "failed", "error": error.message.clone() }),
    };
    machine_api.post(
        &format!("/machines/{}/commands/{command_id}/ack", config.machine_id),
        &ack,
    )?;

    let result = outcome?;
    Ok(json!({ "id": command_id, "kind": kind, "result": result }))
}

/// Downloads the pre-signed bundle named by a materialize command and writes it
/// into the local native store.
fn materialize_from_command(paths: &RuntimePaths, payload: &Value) -> Result<Value, AppError> {
    let url = payload
        .get("downloadUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::network("materialize command did not include downloadUrl"))?;
    let anonymous = ApiClient::new("", None);
    let bytes = anonymous.send_bytes(anonymous.client.get(url))?;
    let bundle: ConversionBundle = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::network(format!("invalid conversion bundle: {error}")))?;
    if let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) {
        if bundle.session_id != session_id {
            return Err(AppError::network(
                "downloaded bundle session id did not match the command",
            ));
        }
    }
    let result = materialize_bundle(&bundle, &paths.home).map_err(map_materialize_error)?;
    serde_json::to_value(result).map_err(|error| AppError::internal(error.to_string()))
}

fn materialize_conversion(
    bundle: ConversionBundle,
    paths: &RuntimePaths,
) -> Result<CommandOutput, AppError> {
    let result = materialize_bundle(&bundle, &paths.home).map_err(map_materialize_error)?;
    Ok(CommandOutput {
        command: "convert".to_owned(),
        data: serde_json::to_value(result)
            .map_err(|error| AppError::internal(error.to_string()))?,
    })
}

fn doctor(paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let config = load_config(paths)?;
    let credential = load_credential(paths)?;
    let queue = OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    let database_ok = queue.integrity_check().map_err(map_queue_error)?;
    let api = ApiClient::new(&config.endpoint, Some(&credential));
    verify_machine(&api, &config.machine_id)?;
    let (machine_token, _) = issue_machine_token(&api, &config.machine_id)?;
    patch_machine_state(&api, &config, paths)?;
    let symlinks = skipped_symlinks(&paths.home);
    let checks = vec![
        json!({ "name": "contract_version", "ok": config.contract_version == memoar_canonical::CONTRACT_VERSION, "detail": config.contract_version }),
        json!({ "name": "queue_integrity", "ok": database_ok, "detail": paths.queue_file() }),
        json!({ "name": "credentials", "ok": !credential.secret().is_empty(), "detail": "credential store contains a token" }),
        json!({ "name": "source_table", "ok": !SOURCES.is_empty(), "detail": format!("{} sources", SOURCES.len()) }),
        json!({ "name": "api_reachable", "ok": true, "detail": config.endpoint }),
        json!({ "name": "machine_registered", "ok": true, "detail": config.machine_id }),
        json!({ "name": "machine_token", "ok": !machine_token.is_empty(), "detail": "machine token issued" }),
        // A source can be detected and still be captured from not at all: a
        // symlinked store is skipped by discovery in silence. Not ok — files
        // this machine believes it is archiving are being dropped.
        json!({
            "name": "source_symlinks",
            "ok": symlinks.is_empty(),
            "detail": if symlinks.is_empty() {
                "no source is behind a symlink".to_owned()
            } else {
                format!("{} skipped: {}", symlinks.len(), symlink_summary(&symlinks))
            },
            "skipped": symlinks
        }),
    ];
    let ok = checks.iter().all(|check| check["ok"] == Value::Bool(true));
    Ok(CommandOutput {
        command: "doctor".to_owned(),
        data: json!({ "ok": ok, "checks": checks }),
    })
}

/// Names the sources rather than the count, so the sentence is actionable.
fn symlink_summary(symlinks: &[Value]) -> String {
    symlinks
        .iter()
        .map(|entry| {
            format!(
                "{} ({})",
                entry["path"].as_str().unwrap_or_default(),
                entry["source"].as_str().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn patch_machine_state(
    api: &ApiClient,
    config: &Config,
    paths: &RuntimePaths,
) -> Result<(), AppError> {
    let source_settings = discover(&paths.home, OperatingSystem::current())
        .into_iter()
        .map(|source| {
            (
                source.id.to_owned(),
                json!({
                    "enabled": !config.disabled_sources.contains(source.id),
                    "detected": source.detected,
                    "tier": source.tier,
                    "stability": source.stability,
                    "paths": source.paths
                }),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    api.patch(
        &format!("/machines/{}", config.machine_id),
        &json!({
            "name": machine_name(),
            "agentVersion": env!("CARGO_PKG_VERSION"),
            "sourceSettings": source_settings
        }),
    )?;
    Ok(())
}

fn verify_machine(api: &ApiClient, machine_id: &str) -> Result<(), AppError> {
    let machines = api.get("/machines")?;
    let found = machines
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|machine| machine.get("id").and_then(Value::as_str) == Some(machine_id))
        });
    if !found {
        return Err(AppError::network(format!(
            "machine {machine_id} is not registered for this credential"
        )));
    }
    Ok(())
}

/// A transport that can replace its own machine token.
///
/// The machine token lives fifteen minutes; a single upload is allowed half an
/// hour. Minting once per batch therefore handed long uploads a credential that
/// had already expired by the time the server read it, and the archive answered
/// 401 after accepting every byte. The transport now mints again whenever the
/// token it holds is close to death, using the account credential — which,
/// since `login` stores an API key, does not itself expire.
fn capture_transport(
    config: &Config,
    credential: &Credential,
    token: &str,
    expires_at: Option<&str>,
) -> HttpTransport {
    let endpoint = config.endpoint.clone();
    let machine_id = config.machine_id.clone();
    let credential = credential.clone();
    HttpTransport::with_minter(
        &config.endpoint,
        token,
        expires_at,
        Some(Box::new(move || {
            let api = ApiClient::new(&endpoint, Some(&credential));
            issue_machine_token(&api, &machine_id)
                .map_err(|error| DaemonError::Transport(error.message.clone()))
        })),
    )
}

/// Mints a machine token, and reports when it dies.
///
/// The expiry is not decoration: it is what lets the transport replace the token
/// before a long upload starts rather than after one has failed.
fn issue_machine_token(
    api: &ApiClient,
    machine_id: &str,
) -> Result<(String, Option<String>), AppError> {
    let response = api.post("/auth/machine-token", &json!({ "machineId": machine_id }))?;
    let token = response
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| AppError::network("machine token response did not include token"))?
        .to_owned();
    let expires_at = response
        .get("expiresAt")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok((token, expires_at))
}

fn validate_uuid_v7(label: &str, value: &str) -> Result<(), AppError> {
    let id = Uuid::parse_str(value)
        .map_err(|error| AppError::network(format!("invalid {label}: {error}")))?;
    if id.get_version_num() != 7 {
        return Err(AppError::network(format!("{label} is not UUIDv7")));
    }
    Ok(())
}

fn authenticated_config(paths: &RuntimePaths) -> Result<(Config, Credential), AppError> {
    Ok((load_config(paths)?, load_credential(paths)?))
}

fn load_credential(paths: &RuntimePaths) -> Result<Credential, AppError> {
    paths
        .credential_store()
        .load()?
        .ok_or_else(AppError::not_initialized)
}

fn load_config(paths: &RuntimePaths) -> Result<Config, AppError> {
    load_config_optional(paths)?.ok_or_else(AppError::not_initialized)
}

fn load_config_optional(paths: &RuntimePaths) -> Result<Option<Config>, AppError> {
    let path = paths.config_file();
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|error| {
        AppError::internal(format!("could not read {}: {error}", path.display()))
    })?;
    let config = serde_json::from_slice(&bytes).map_err(|error| {
        AppError::internal(format!("invalid config {}: {error}", path.display()))
    })?;
    Ok(Some(config))
}

fn save_config(paths: &RuntimePaths, config: &Config) -> Result<(), AppError> {
    let bytes =
        serde_json::to_vec_pretty(config).map_err(|error| AppError::internal(error.to_string()))?;
    atomic_replace(&paths.config_file(), &bytes, 0o600)
}

fn atomic_replace(path: &Path, bytes: &[u8], unix_mode: u32) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::internal(format!("{} has no parent", path.display())))?;
    fs::create_dir_all(parent).map_err(|error| {
        AppError::internal(format!("could not create {}: {error}", parent.display()))
    })?;
    let temporary = parent.join(format!(".memoar-{}.tmp", Uuid::now_v7()));
    let result = (|| -> Result<(), std::io::Error> {
        let mut file = create_private(&temporary, unix_mode)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            // umask can only clear bits, never add them, so this cannot loosen
            // the file. It pins the exact mode when a restrictive umask would
            // otherwise have dropped a bit the caller asked for.
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(unix_mode))?;
        }
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| {
        AppError::internal(format!("could not replace {}: {error}", path.display()))
    })
}

/// Creates a file that has its final permissions from the moment it exists.
///
/// The access token used to be written into a temporary file opened with the
/// default umask — world-readable on a typical machine — and only chmod'ed to
/// 0600 after the bytes had been written and flushed. Any local process could
/// read the token during that window. The mode has to be part of the open, not
/// a correction applied afterwards.
#[cfg(unix)]
fn create_private(path: &Path, unix_mode: u32) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(unix_mode)
        .open(path)
}

#[cfg(not(unix))]
fn create_private(path: &Path, _unix_mode: u32) -> std::io::Result<File> {
    OpenOptions::new().create_new(true).write(true).open(path)
}

/// A dead host should not cost a whole download budget to discover.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a control-plane request may take.
///
/// Registering a machine, minting a token, listing sessions: all of them are a
/// few kilobytes of JSON, and one that has not answered in two minutes is not
/// going to. This budget is deliberately not the one a bundle download gets.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// The largest conversion bundle the materializer will accept, decoded.
///
/// It caps a single file at 512 MiB and the bundle's total at twice that, so
/// this is the most bytes a `convert --here` can legitimately be waiting for.
/// Declared here rather than imported so the download budget is not silently
/// re-tuned by a change in another crate: if the materializer's ceiling moves,
/// this constant and the test below are what notice.
pub const MAX_CONVERSION_BUNDLE_BYTES: u64 = 2 * 512 * 1024 * 1024;

/// Bundle files travel base64-encoded, which costs four bytes per three.
pub const BASE64_EXPANSION_NUMERATOR: u64 = 4;
pub const BASE64_EXPANSION_DENOMINATOR: u64 = 3;

/// The slowest uplink a download is still expected to finish on: 2 Mbit/s.
/// The same floor the upload path is budgeted for. Below it the agent is
/// entitled to give up; at or above it, a timeout that fires is a bug in the
/// timeout, not a slow network.
pub const SLOWEST_TOLERATED_BYTES_PER_SEC: u64 = 256 * 1024;

/// How long a conversion bundle download may take.
///
/// Not a free parameter: it has to cover `MAX_CONVERSION_BUNDLE_BYTES`, base64
/// expanded, at `SLOWEST_TOLERATED_BYTES_PER_SEC`, and a test holds it to that.
/// reqwest's 30-second default did not cover 8 MB, so every non-trivial
/// `memoar convert --here` failed on a deadline it could never meet — the same
/// defect already fixed on the upload side, left standing on this one.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

struct ApiClient {
    client: Client,
    endpoint: String,
    credential: Option<Credential>,
    /// What a bundle download gets instead of `REQUEST_TIMEOUT`. A field rather
    /// than a constant at the call site so a test can prove the download path
    /// uses this budget and not the control-plane one.
    download_timeout: Duration,
}

impl ApiClient {
    fn new(endpoint: &str, credential: Option<&Credential>) -> Self {
        Self::with_timeouts(endpoint, credential, REQUEST_TIMEOUT, DOWNLOAD_TIMEOUT)
    }

    fn with_timeouts(
        endpoint: &str,
        credential: Option<&Credential>,
        request: Duration,
        download: Duration,
    ) -> Self {
        Self {
            // A whole-request cap is the wrong shape for a client that both asks
            // small questions and pulls a bundle: one budget cannot be both
            // short enough to notice a dead archive and long enough to carry
            // half a gigabyte. So: fail fast on connect, keep the short budget
            // for JSON, and let the download ask for its own.
            client: Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(request)
                .build()
                .expect("static HTTP client configuration must be valid"),
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            credential: credential.cloned(),
            download_timeout: download,
        }
    }

    fn authorize(&self, request: RequestBuilder) -> RequestBuilder {
        // An API key is a header the server looks up directly; a bearer token is
        // verified as a signed token. Sending a key as a bearer authenticates
        // nobody, so the two are not interchangeable at the wire.
        match &self.credential {
            Some(Credential::ApiKey(secret)) => request.header("x-memoar-key", secret),
            Some(Credential::Bearer(token)) => request.bearer_auth(token),
            None => request,
        }
    }

    fn post(&self, path: &str, body: &Value) -> Result<Value, AppError> {
        self.send_json(self.authorize(self.client.post(self.url(path))).json(body))
    }

    fn patch(&self, path: &str, body: &Value) -> Result<Value, AppError> {
        self.send_json(self.authorize(self.client.patch(self.url(path))).json(body))
    }

    fn get(&self, path: &str) -> Result<Value, AppError> {
        self.send_json(self.authorize(self.client.get(self.url(path))))
    }

    fn get_query(
        &self,
        path: &str,
        query: &[(impl AsRef<str>, String)],
    ) -> Result<Value, AppError> {
        let query: Vec<_> = query
            .iter()
            .map(|(key, value)| (key.as_ref(), value.as_str()))
            .collect();
        self.send_json(
            self.authorize(self.client.get(self.url(path)))
                .query(&query),
        )
    }

    fn download_conversion(&self, path: &str) -> Result<ConversionBundle, AppError> {
        let bytes = self.send_bytes(
            self.authorize(self.client.get(self.url(path)))
                .timeout(self.download_timeout),
        )?;
        if let Ok(bundle) = serde_json::from_slice::<ConversionBundle>(&bytes) {
            return Ok(bundle);
        }
        let response: Value = serde_json::from_slice(&bytes)
            .map_err(|error| AppError::network(format!("invalid download response: {error}")))?;
        let url = response
            .get("url")
            .or_else(|| response.get("downloadUrl"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::network("download response did not include a bundle or URL")
            })?;
        // The redirect to storage carries the same bytes, so it carries the
        // same budget: the 30-second default cut this one off too.
        let bytes = self.send_bytes(self.client.get(url).timeout(self.download_timeout))?;
        serde_json::from_slice(&bytes)
            .map_err(|error| AppError::network(format!("invalid conversion bundle: {error}")))
    }

    fn send_json(&self, request: RequestBuilder) -> Result<Value, AppError> {
        let response = self.send(request)?;
        if response.status().as_u16() == 204 {
            return Ok(json!({}));
        }
        response
            .json()
            .map_err(|error| AppError::network(format!("invalid JSON response: {error}")))
    }

    fn send_bytes(&self, request: RequestBuilder) -> Result<Vec<u8>, AppError> {
        self.send(request)?
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|error| AppError::network(transport_message(&error)))
    }

    fn send(&self, request: RequestBuilder) -> Result<Response, AppError> {
        let response = request
            .send()
            .map_err(|error| AppError::network(transport_message(&error)))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(AppError::network(problem_message(status.as_u16(), &body)));
        }
        Ok(response)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoint, path)
    }
}

/// A transport failure the operator can act on.
///
/// `reqwest::Error` renders as "error sending request for url (...)" and keeps
/// the reason — connection reset, timed out, certificate — in its source chain.
/// Printing only the top of that chain is why `memoar login` behind a
/// TLS-inspecting proxy reported the URL and nothing about the certificate, and
/// the operator had no way to tell a refused connection from a rejected one.
/// The daemon walks the chain for exactly this reason; so does this.
fn transport_message(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    if error.is_timeout() {
        message.push_str(" (timed out)");
    }
    message
}

/// What to say when the archive refuses a request.
///
/// The server answers with an RFC 9457 problem document, and this printed the
/// document: a stale credential produced `HTTP 401 Unauthorized:
/// {"type":"https://memoar.dev/problems/unauthorized","title":"Unauthorized",
/// "status":401,...}` on the terminal. The web client had the same defect.
fn problem_message(status: u16, body: &str) -> String {
    let described = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|problem| {
            let field = |name: &str| problem.get(name).and_then(Value::as_str).map(str::to_owned);
            field("detail").or_else(|| field("title"))
        })
        .unwrap_or_else(|| status_sentence(status));
    format!("{described} (HTTP {status})")
}

/// The fallback when the body says nothing worth reading.
fn status_sentence(status: u16) -> String {
    match status {
        401 => "This machine is not signed in. Run `memoar login`.".to_owned(),
        403 => "These credentials do not allow that.".to_owned(),
        404 => "The archive has no such thing.".to_owned(),
        409 => "That conflicts with something already in the archive.".to_owned(),
        413 => "That is larger than the archive accepts.".to_owned(),
        429 => "Too many requests. Wait a moment and retry.".to_owned(),
        500..=599 => "The archive is having trouble. Retry shortly.".to_owned(),
        _ => "The request failed.".to_owned(),
    }
}

fn map_queue_error(error: DaemonError) -> AppError {
    AppError::queue(error.to_string())
}

fn map_capture_error(error: DaemonError) -> AppError {
    match error {
        DaemonError::UnsupportedRedaction(_) | DaemonError::Zip { .. } => {
            AppError::usage(error.to_string())
        }
        _ => AppError::queue(error.to_string()),
    }
}

fn map_sync_error(error: DaemonError) -> AppError {
    match error {
        DaemonError::Transport(_) => AppError::network(error.to_string()),
        _ => AppError::queue(error.to_string()),
    }
}

fn map_materialize_error(error: MaterializeError) -> AppError {
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

fn machine_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "memoar-machine".to_owned())
}

#[must_use]
pub fn success_envelope(output: &CommandOutput) -> Value {
    json!({
        "ok": true,
        "version": ROBOT_ENVELOPE_VERSION,
        "command": output.command,
        "data": output.data
    })
}

#[must_use]
pub fn error_envelope(error: &AppError) -> Value {
    json!({ "error": error })
}

#[must_use]
pub fn capabilities_value() -> Value {
    json!({
        "contractVersion": memoar_canonical::CONTRACT_VERSION,
        "clientVersion": env!("CARGO_PKG_VERSION"),
        "robotEnvelopeVersion": ROBOT_ENVELOPE_VERSION,
        "json": true,
        "offlineQueue": "sqlite-wal",
        "contentAddress": "sha256",
        "clientRedaction": ["text", "zip"],
        "opaqueRedaction": "fail-closed",
        "bundleIntegrity": ["bundle-sha256", "file-sha256", "size"],
        "noClobber": true,
        "sources": SOURCES.iter().map(|source| source.id).collect::<Vec<_>>(),
        "materializationTargets": ["claude-code", "codex", "antigravity-cli"]
    })
}

#[must_use]
pub fn introspect_value() -> Value {
    json!({
        "name": "memoar",
        "clientVersion": env!("CARGO_PKG_VERSION"),
        "contractVersion": memoar_canonical::CONTRACT_VERSION,
        "commands": [
            { "name": "login", "requiresAuth": false, "network": true },
            { "name": "status", "requiresAuth": true, "network": false },
            { "name": "sources list", "requiresAuth": false, "network": false },
            { "name": "sources enable", "requiresAuth": true, "network": true },
            { "name": "sources disable", "requiresAuth": true, "network": true },
            { "name": "sync", "requiresAuth": true, "network": true },
            { "name": "redaction", "requiresAuth": true, "network": false },
            { "name": "search", "requiresAuth": true, "network": true },
            { "name": "view", "requiresAuth": true, "network": true },
            { "name": "pack", "requiresAuth": true, "network": true },
            { "name": "convert", "requiresAuth": true, "network": true },
            { "name": "doctor", "requiresAuth": true, "network": true },
            { "name": "capabilities", "requiresAuth": false, "network": false },
            { "name": "introspect", "requiresAuth": false, "network": false }
        ],
        "exitCodes": {
            "ok": EXIT_OK,
            "usage": EXIT_USAGE,
            "notInitialized": EXIT_NOT_INITIALIZED,
            "network": EXIT_NETWORK,
            "lock": EXIT_LOCKED,
            "unknown": EXIT_UNKNOWN
        },
        "errorEnvelope": {
            "fields": ["code", "kind", "message", "hint", "retryable"]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{problem_message, status_sentence};

    /// A rejected request used to print the whole problem document at the
    /// terminal, wire format and all.
    #[test]
    fn a_refusal_reads_as_a_sentence() {
        let body = r#"{"type":"https://memoar.dev/problems/unauthorized","title":"Unauthorized","status":401,"code":"unauthorized","detail":"Valid bearer, machine, or API-key credentials are required","requestId":"fd492b99"}"#;

        let message = problem_message(401, body);

        assert_eq!(
            message,
            "Valid bearer, machine, or API-key credentials are required (HTTP 401)"
        );
        assert!(!message.contains('{'), "no wire format reaches the reader");
        assert!(!message.contains("memoar.dev/problems"));
    }

    #[test]
    fn a_title_stands_in_when_there_is_no_detail() {
        let message = problem_message(409, r#"{"title":"Email already registered","status":409}"#);
        assert_eq!(message, "Email already registered (HTTP 409)");
    }

    #[test]
    fn a_body_that_is_not_a_problem_document_says_something_useful() {
        // A proxy answering instead of the archive: an HTML error page dumped
        // on the terminal is worse than a sentence about the status.
        let message = problem_message(502, "<html><body>502 Bad Gateway</body></html>");
        assert_eq!(
            message,
            "The archive is having trouble. Retry shortly. (HTTP 502)"
        );
        assert!(!message.contains("<html>"));
    }

    #[test]
    fn an_unsigned_machine_is_told_what_to_run() {
        assert!(status_sentence(401).contains("memoar login"));
    }

    #[test]
    fn sse_decoder_yields_complete_events_only() {
        let mut decoder = SseDecoder::new();
        // A frame split across reads must not surface until it is complete.
        assert!(
            decoder
                .push("event: command\ndata: {\"id\":\"a\"")
                .is_empty()
        );
        let events = decoder.push("}\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "command");
        assert_eq!(events[0].data, "{\"id\":\"a\"}");
    }

    #[test]
    fn sse_decoder_handles_several_frames_in_one_chunk() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push("event: ping\ndata: 1\n\nevent: command\ndata: {}\n\n");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event, "ping");
        assert_eq!(events[1].event, "command");
    }

    #[test]
    fn sse_decoder_ignores_comments_and_dataless_frames() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push(": keep-alive\n\n").is_empty());
        assert!(decoder.push("event: command\n\n").is_empty());
    }

    #[test]
    fn sse_decoder_joins_multi_line_data_and_defaults_the_event_name() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push("data: first\ndata: second\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "message");
        assert_eq!(events[0].data, "first\nsecond");
    }

    use super::*;

    fn fixture_paths(temp: &tempfile::TempDir) -> RuntimePaths {
        RuntimePaths {
            config_dir: temp.path().join("config"),
            data_dir: temp.path().join("data"),
            home: temp.path().join("fixture-home"),
        }
    }

    #[test]
    fn every_required_command_parses() {
        let commands = [
            vec!["memoar", "login", "--token", "test"],
            vec!["memoar", "status"],
            vec!["memoar", "sources", "list"],
            vec!["memoar", "sources", "enable", "codex"],
            vec!["memoar", "sources", "disable", "codex"],
            vec!["memoar", "sync"],
            vec!["memoar", "search", "queue bug"],
            vec!["memoar", "view", "session-id"],
            vec!["memoar", "pack", "queue bug"],
            vec!["memoar", "convert", "session-id", "--target", "codex"],
            vec!["memoar", "doctor"],
            vec!["memoar", "capabilities"],
            vec!["memoar", "introspect"],
        ];
        for command in commands {
            Cli::try_parse_from(command).unwrap();
        }
    }

    #[test]
    fn capabilities_match_golden_contract() {
        let expected: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/golden/capabilities.json"
        )))
        .unwrap();
        let output = CommandOutput {
            command: "capabilities".to_owned(),
            data: capabilities_value(),
        };
        assert_eq!(success_envelope(&output), expected);
    }

    #[test]
    fn introspect_matches_golden_contract() {
        let expected: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/golden/introspect.json"
        )))
        .unwrap();
        let output = CommandOutput {
            command: "introspect".to_owned(),
            data: introspect_value(),
        };
        assert_eq!(success_envelope(&output), expected);
    }

    #[test]
    fn not_initialized_error_matches_golden_and_exit() {
        let error = AppError::not_initialized();
        let expected: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/golden/error-not-initialized.json"
        )))
        .unwrap();
        assert_eq!(error.exit_code, EXIT_NOT_INITIALIZED);
        assert_eq!(error_envelope(&error), expected);
    }

    #[test]
    fn credentials_are_separate_and_mode_is_private() {
        let temp = tempfile::tempdir().unwrap();
        let paths = fixture_paths(&temp);
        fs::create_dir_all(&paths.home).unwrap();
        let config = Config {
            contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
            endpoint: "http://127.0.0.1:4000/v1".to_owned(),
            machine_id: "0198d8d0-977c-777b-9f8f-0f6d8416e700".to_owned(),
            disabled_sources: BTreeSet::new(),
            redaction: RedactionConfig::disabled(),
        };
        save_config(&paths, &config).unwrap();
        paths
            .credential_store()
            .store(&Credential::Bearer("secret-user-token".to_owned()))
            .unwrap();
        let config_text = fs::read_to_string(paths.config_file()).unwrap();
        assert!(!config_text.contains("secret-user-token"));
        assert_eq!(
            load_credential(&paths).unwrap(),
            Credential::Bearer("secret-user-token".to_owned())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(paths.credentials_file())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_credential_file_is_never_briefly_world_readable() {
        // The test below this one checks the mode of the finished file, which
        // stayed green while the token was written into a temporary opened at
        // the default umask and only tightened afterwards. What matters is the
        // mode the file has the instant it exists, so that is what is asserted.
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("secret");
        let file = create_private(&path, 0o600).unwrap();
        let mode = file.metadata().unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "the file was readable by others before anything was written to it"
        );
        drop(file);
    }

    #[cfg(unix)]
    #[test]
    fn no_temporary_file_survives_a_credential_write() {
        // A leftover .memoar-*.tmp would hold the token under whatever mode it
        // was created with, outliving the window entirely.
        let temp = tempfile::tempdir().unwrap();
        let paths = fixture_paths(&temp);
        paths
            .credential_store()
            .store(&Credential::Bearer("secret-user-token".to_owned()))
            .unwrap();
        let parent = paths.credentials_file().parent().unwrap().to_owned();
        let leftovers: Vec<_> = fs::read_dir(&parent)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".memoar-") && name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temporary credential files were left behind: {leftovers:?}"
        );
    }

    #[test]
    fn generated_local_ids_are_uuid_v7() {
        let id = Uuid::now_v7();
        assert_eq!(id.get_version_num(), 7);
    }

    #[test]
    fn arbitrary_target_is_allowed_only_for_remote_injection() {
        let args = ConvertArgs {
            session_id: "session".to_owned(),
            target: "future-agent".to_owned(),
            fallback: "injection".to_owned(),
            here: true,
            bundle: None,
            wait_seconds: 1,
            poll_milliseconds: 25,
        };
        let temp = tempfile::tempdir().unwrap();
        let paths = fixture_paths(&temp);
        assert_eq!(convert(&args, &paths).unwrap_err().exit_code, EXIT_USAGE);
    }

    const MACHINE_ID: &str = "0198d8d0-977c-777b-9f8f-0f6d8416e700";

    #[derive(Debug, Clone)]
    struct RecordedRequest {
        method: String,
        path: String,
        headers: String,
        body: Vec<u8>,
    }

    /// What the mock archive does before it answers.
    #[derive(Default)]
    struct MockOptions {
        request_count: usize,
        conversion_bundle: Option<Value>,
        workspace: String,
        /// Connections accepted and dropped without a reply, before any request
        /// is answered: what a closed lid or a changed network looks like from
        /// the client's side.
        dropped_connections: usize,
        /// A path substring whose response is held back, and for how long, so a
        /// test can find out which timeout a request was given.
        slow_path: &'static str,
        slow_by: Duration,
    }

    fn spawn_mock_api(
        request_count: usize,
        conversion_bundle: Option<Value>,
    ) -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<RecordedRequest>>>,
        std::thread::JoinHandle<()>,
    ) {
        spawn_mock_api_with_workspace(request_count, conversion_bundle, String::new())
    }

    /// `workspace` is the project root the mock claims to have sessions in, so a
    /// test can put memory files there and watch them being captured.
    fn spawn_mock_api_with_workspace(
        request_count: usize,
        conversion_bundle: Option<Value>,
        workspace: String,
    ) -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<RecordedRequest>>>,
        std::thread::JoinHandle<()>,
    ) {
        spawn_mock(MockOptions {
            request_count,
            conversion_bundle,
            workspace,
            ..MockOptions::default()
        })
    }

    fn spawn_mock(
        options: MockOptions,
    ) -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<RecordedRequest>>>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let MockOptions {
            request_count,
            conversion_bundle,
            workspace,
            dropped_connections,
            slow_path,
            slow_by,
        } = options;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let handle = std::thread::spawn(move || {
            // Accepted and hung up on: the client sees a transport failure with
            // no HTTP status to interpret, which is the case the watcher used to
            // die on.
            for _ in 0..dropped_connections {
                drop(listener.accept().unwrap());
            }
            for _ in 0..request_count {
                let (mut stream, _) = listener.accept().unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0_u8; 4096];
                let header_end = loop {
                    let read = stream.read(&mut buffer).unwrap();
                    assert!(read > 0, "client closed before HTTP headers");
                    bytes.extend_from_slice(&buffer[..read]);
                    if let Some(position) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        break position + 4;
                    }
                };
                let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(str::trim)
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + content_length {
                    let read = stream.read(&mut buffer).unwrap();
                    assert!(read > 0, "client closed before HTTP body");
                    bytes.extend_from_slice(&buffer[..read]);
                }
                let request_line = headers.lines().next().unwrap();
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap().to_owned();
                let path = parts.next().unwrap().to_owned();
                let body = bytes[header_end..header_end + content_length].to_vec();
                recorded.lock().unwrap().push(RecordedRequest {
                    method: method.clone(),
                    path: path.clone(),
                    headers: headers.clone(),
                    body: body.clone(),
                });

                let (status, response) = match (method.as_str(), path.as_str()) {
                    ("POST", "/v1/auth/login") => (200, json!({"accessToken": "user-token"})),
                    ("POST", "/v1/machines") => (201, json!({"id": MACHINE_ID})),
                    ("PATCH", path) if path.starts_with("/v1/machines/") => (200, json!({})),
                    ("GET", "/v1/machines") => (200, json!({"items": [{"id": MACHINE_ID}]})),
                    ("POST", "/v1/auth/api-keys") => (
                        201,
                        json!({"apiKey": {"id": "key-1"}, "secret": "memoar_test-capture-key"}),
                    ),
                    ("POST", "/v1/auth/machine-token") => (
                        201,
                        json!({"token": "machine-token", "expiresAt": "2099-01-01T00:00:00Z"}),
                    ),
                    ("POST", "/v1/ingest/delta") => {
                        let request: Value = serde_json::from_slice(&body).unwrap();
                        (200, json!({"missing": request["hashes"]}))
                    }
                    ("PUT", path) if path.starts_with("/v1/ingest/artifacts/") => (201, json!({})),
                    ("POST", "/v1/ingest/manifests") => {
                        let request: Value = serde_json::from_slice(&body).unwrap();
                        (
                            202,
                            json!({
                                "batchId": request["batchId"],
                                "accepted": request["artifacts"].as_array().unwrap().len(),
                                "duplicate": 0,
                                "queuedAt": "2026-08-18T00:00:00Z"
                            }),
                        )
                    }
                    ("GET", path) if path.starts_with("/v1/search?") => {
                        (200, json!({"items": [], "nextCursor": null}))
                    }
                    ("GET", path) if path.starts_with("/v1/sessions/") => {
                        (200, json!({"session": {"id": "session"}, "turns": []}))
                    }
                    // The workspaces this account has archived sessions in, which
                    // is how the agent knows which directories are projects.
                    ("GET", path) if path.starts_with("/v1/sessions") => (
                        200,
                        json!({"items": [{"id": "session", "workspace": workspace.clone()}]}),
                    ),
                    ("POST", "/v1/memory") => (
                        200,
                        json!({"document": {"id": MACHINE_ID}, "revision": {"id": MACHINE_ID}}),
                    ),
                    ("POST", "/v1/pack") => (202, json!({"id": "pack-job"})),
                    ("POST", "/v1/convert") => (
                        202,
                        json!({
                            "id": "conversion-job",
                            "status": "ready",
                            "sessionId": MACHINE_ID,
                            "target": "claude-code"
                        }),
                    ),
                    ("GET", "/v1/convert/conversion-job/download") => (
                        200,
                        conversion_bundle
                            .clone()
                            .expect("bundle response configured"),
                    ),
                    other => panic!("unexpected mock request: {other:?}"),
                };
                let response = serde_json::to_vec(&response).unwrap();
                if !slow_path.is_empty() && path.contains(slow_path) {
                    std::thread::sleep(slow_by);
                }
                // Writing is allowed to fail: a test that deliberately times a
                // request out has already closed this socket, and that is the
                // test passing, not the mock breaking.
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    response.len()
                );
                let _ = stream.write_all(&response);
            }
        });
        (endpoint, requests, handle)
    }

    fn configured_paths(temp: &tempfile::TempDir, endpoint: &str) -> RuntimePaths {
        let paths = fixture_paths(temp);
        fs::create_dir_all(&paths.home).unwrap();
        save_config(
            &paths,
            &Config {
                contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
                endpoint: endpoint.to_owned(),
                machine_id: MACHINE_ID.to_owned(),
                disabled_sources: BTreeSet::new(),
                redaction: RedactionConfig::disabled(),
            },
        )
        .unwrap();
        paths
            .credential_store()
            .store(&Credential::Bearer("user-token".to_owned()))
            .unwrap();
        paths
    }

    /// `login` must not leave the agent holding the account's browser token.
    ///
    /// That token expires in an hour and the server issues no refresh for it, so
    /// every later command — above all `sync --watch`, which exists to keep
    /// running — died on `401 Valid bearer, machine, or API-key credentials are
    /// required` and could only be revived by typing a password again. What is
    /// stored is a capture-scoped API key, and what goes on the wire afterwards
    /// is `x-memoar-key`, not the bearer.
    #[test]
    fn login_trades_the_hour_long_token_for_a_capture_key() {
        let (endpoint, requests, server) = spawn_mock_api(7, None);
        let temp = tempfile::tempdir().unwrap();
        let paths = fixture_paths(&temp);
        fs::create_dir_all(&paths.home).unwrap();
        let result = login(
            &LoginArgs {
                endpoint,
                email: Some("person@example.com".to_owned()),
                password: Some("correct horse battery staple".to_owned()),
                token: None,
                machine_id: None,
                redact_secrets: true,
                redact_email_addresses: false,
                redact_home_paths: false,
            },
            &paths,
        )
        .unwrap();
        assert_eq!(result.data["machineId"], MACHINE_ID);
        assert_eq!(result.data["credential"], "api-key");
        assert_eq!(
            load_credential(&paths).unwrap(),
            Credential::ApiKey("memoar_test-capture-key".to_owned()),
            "the stored credential must be the key, not the hour-long token"
        );
        assert_eq!(doctor(&paths).unwrap().data["ok"], true);
        server.join().unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[0].path, "/v1/auth/login");
        assert!(
            requests[1]
                .headers
                .contains("authorization: Bearer user-token")
        );
        assert!(
            requests[2]
                .body
                .windows(12)
                .any(|part| part == b"agentVersion")
        );
        let key_request = requests
            .iter()
            .find(|request| request.path == "/v1/auth/api-keys")
            .expect("login must mint a capture key");
        let scopes = String::from_utf8_lossy(&key_request.body);
        for scope in CAPTURE_SCOPES {
            assert!(scopes.contains(scope), "capture key must request {scope}");
        }
        for withheld in ["sharing:write", "keys:write", "mcp:use"] {
            assert!(
                !scopes.contains(withheld),
                "a credential that lives on a laptop forever must not carry {withheld}"
            );
        }
        // Everything after the key exists is authenticated by the key.
        let after_key = requests
            .iter()
            .skip_while(|request| request.path != "/v1/auth/api-keys")
            .skip(1);
        for request in after_key {
            assert!(
                request.headers.contains("x-memoar-key: memoar_"),
                "{} still used the expiring token",
                request.path
            );
        }
    }

    #[test]
    fn http_sync_negotiates_uploads_raw_bytes_and_submits_manifest() {
        let (endpoint, requests, server) = spawn_mock_api(5, None);
        let temp = tempfile::tempdir().unwrap();
        let paths = configured_paths(&temp, &endpoint);
        let session = paths.home.join(".claude/projects/-fixture/session.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::write(&session, b"{\"type\":\"user\"}\n").unwrap();
        let result = sync(
            &SyncArgs {
                watch: false,
                interval_seconds: 1,
                debounce_seconds: 1,
                max_cycles: 0,
            },
            false,
            &paths,
        )
        .unwrap();
        assert_eq!(result.data["sync"]["uploaded"], 1);
        server.join().unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests[2].path, "/v1/ingest/delta");
        assert!(requests[3].path.starts_with("/v1/ingest/artifacts/"));
        assert_eq!(requests[3].body, b"{\"type\":\"user\"}\n");
        assert_eq!(requests[4].path, "/v1/ingest/manifests");
    }

    #[test]
    fn sync_captures_the_memory_files_of_projects_the_archive_knows() {
        // What the agents on this machine are told is part of the archive: a
        // transcript cannot be read for what it was without the instructions it
        // was produced under. Which directories are projects is not something
        // the agent can know by looking, so it asks the archive, which knows
        // because every transcript names the directory it was recorded in.
        let temp = tempfile::tempdir().unwrap();
        // Inside the capture home, because that is the only place a
        // server-supplied workspace is now allowed to point.
        let project = temp.path().join("fixture-home/project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("AGENTS.md"), "project rules").unwrap();

        let (endpoint, requests, server) =
            spawn_mock_api_with_workspace(8, None, project.to_string_lossy().into_owned());
        let paths = configured_paths(&temp, &endpoint);
        fs::create_dir_all(paths.home.join(".claude")).unwrap();
        fs::write(paths.home.join(".claude/CLAUDE.md"), "be terse").unwrap();
        let session = paths.home.join(".claude/projects/-fixture/session.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        fs::write(&session, b"{\"type\":\"user\"}\n").unwrap();

        let result = sync(
            &SyncArgs {
                watch: false,
                interval_seconds: 1,
                debounce_seconds: 1,
                max_cycles: 0,
            },
            false,
            &paths,
        )
        .unwrap();

        assert_eq!(result.data["memory"]["found"], 2, "one global, one project");
        assert_eq!(result.data["memory"]["uploaded"], 2);
        assert_eq!(result.data["memory"]["recorded"], 2);
        server.join().unwrap();

        let requests = requests.lock().unwrap();
        let captured: Vec<Value> = requests
            .iter()
            .filter(|request| request.path == "/v1/memory")
            .map(|request| serde_json::from_slice(&request.body).unwrap())
            .collect();
        assert_eq!(captured.len(), 2);
        let project_file = captured
            .iter()
            .find(|body| body["scope"] == "project")
            .expect("the project's own AGENTS.md");
        assert_eq!(project_file["text"], "project rules");
        assert!(
            project_file["readers"]
                .as_array()
                .unwrap()
                .contains(&json!("codex")),
            "the tools that read this path, not the one that wrote it"
        );
        // A machine token, not the user session: this is capture.
        assert!(
            requests
                .iter()
                .find(|request| request.path == "/v1/memory")
                .unwrap()
                .headers
                .contains("authorization: Bearer machine-token")
        );
    }

    /// A workspace is a string the server chose, and it was being used as a
    /// local read root on the strength of "absolute and a directory" alone.
    /// An archive that is compromised, or simply wrong, could answer
    /// `"workspace": "/Users/someone-else"` and this machine would read that
    /// directory's instruction files and upload them. The server does not get
    /// to choose which local files the client reads.
    #[test]
    fn a_workspace_outside_the_capture_home_is_never_read() {
        let temp = tempfile::tempdir().unwrap();
        let elsewhere = temp.path().join("someone-else");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("AGENTS.md"), "not this machine's to send").unwrap();

        let (endpoint, requests, server) =
            spawn_mock_api_with_workspace(4, None, elsewhere.to_string_lossy().into_owned());
        let paths = configured_paths(&temp, &endpoint);
        fs::create_dir_all(paths.home.join(".claude")).unwrap();
        fs::write(paths.home.join(".claude/CLAUDE.md"), "be terse").unwrap();

        let result = sync(
            &SyncArgs {
                watch: false,
                interval_seconds: 1,
                debounce_seconds: 1,
                max_cycles: 0,
            },
            false,
            &paths,
        )
        .unwrap();

        assert_eq!(
            result.data["memory"]["found"], 1,
            "only this home's own instruction file"
        );
        server.join().unwrap();
        let requests = requests.lock().unwrap();
        assert!(
            !requests.iter().any(|request| {
                String::from_utf8_lossy(&request.body).contains("not this machine's to send")
            }),
            "a directory the user never nominated was read and uploaded"
        );
    }

    /// Redaction was applied to transcripts and to nothing else.
    ///
    /// Somebody who ran `memoar login --redact-secrets` had their sessions
    /// scrubbed and their `~/.claude/CLAUDE.md`, every project `AGENTS.md` and
    /// every `~/.claude/projects/*/memory/*.md` uploaded byte for byte — which
    /// are precisely the files a connection string or an API key gets pasted
    /// into, and they had been told masking was on.
    #[test]
    fn a_secret_in_an_instruction_file_is_masked_before_it_leaves() {
        let temp = tempfile::tempdir().unwrap();
        let (endpoint, requests, server) = spawn_mock_api(4, None);
        let paths = configured_paths(&temp, &endpoint);
        let mut config = load_config(&paths).unwrap();
        config.redaction = RedactionConfig {
            secrets: true,
            email_addresses: false,
            home_paths: false,
        };
        save_config(&paths, &config).unwrap();
        fs::create_dir_all(paths.home.join(".claude")).unwrap();
        fs::write(
            paths.home.join(".claude/CLAUDE.md"),
            "Use the staging archive.\nANTHROPIC_API_KEY=sk-live-do-not-upload\n",
        )
        .unwrap();

        let result = sync(
            &SyncArgs {
                watch: false,
                interval_seconds: 1,
                debounce_seconds: 1,
                max_cycles: 0,
            },
            false,
            &paths,
        )
        .unwrap();

        assert_eq!(result.data["memory"]["uploaded"], 1);
        server.join().unwrap();
        let requests = requests.lock().unwrap();
        let sent: Vec<String> = requests
            .iter()
            .filter(|request| request.path == "/v1/memory")
            .map(|request| String::from_utf8_lossy(&request.body).into_owned())
            .collect();
        assert_eq!(sent.len(), 1);
        assert!(
            !sent[0].contains("sk-live-do-not-upload"),
            "the key went up under a receipt saying masking was on: {}",
            sent[0]
        );
        assert!(
            sent[0].contains("[REDACTED]"),
            "masked, not dropped — the rest of the file is still the archive's: {}",
            sent[0]
        );
    }

    /// The sweep remembers which instruction files it has already sent, and a
    /// fresh one each cycle remembers nothing. Now that a watch survives its own
    /// failures and runs indefinitely, that is every instruction file on the
    /// machine re-uploaded every interval, for as long as the laptop is on.
    #[test]
    fn a_watch_does_not_re_upload_an_unchanged_instruction_file() {
        let temp = tempfile::tempdir().unwrap();
        // Room for a second upload, so the failure is an assertion about what
        // was sent rather than a test that hangs waiting for a request the fix
        // prevents. The server is left blocked on accept for the same reason.
        let (endpoint, requests, _server) = spawn_mock_api(9, None);
        let paths = configured_paths(&temp, &endpoint);
        fs::create_dir_all(paths.home.join(".claude")).unwrap();
        fs::write(paths.home.join(".claude/CLAUDE.md"), "be terse").unwrap();

        sync(
            &SyncArgs {
                watch: true,
                interval_seconds: 1,
                debounce_seconds: 1,
                max_cycles: 2,
            },
            false,
            &paths,
        )
        .unwrap();

        let uploads = requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.path == "/v1/memory")
            .count();
        assert_eq!(
            uploads, 1,
            "two cycles, one unchanged file: it was sent {uploads} times"
        );
    }

    /// A watcher that dies on the first transport failure is a watcher that
    /// cannot do its job: the offline queue exists so a closed lid or a changed
    /// network costs nothing, and `sync --watch` was the one thing on the
    /// machine that could not survive either.
    #[test]
    fn a_lost_network_does_not_end_a_watch() {
        let (endpoint, requests, server) = spawn_mock(MockOptions {
            request_count: 3,
            dropped_connections: 1,
            ..MockOptions::default()
        });
        let temp = tempfile::tempdir().unwrap();
        let paths = configured_paths(&temp, &endpoint);

        let started = Instant::now();
        let result = sync(
            &SyncArgs {
                watch: true,
                interval_seconds: 1,
                debounce_seconds: 1,
                max_cycles: 1,
            },
            false,
            &paths,
        )
        .expect("a dropped connection must be retried, not fatal");

        assert!(
            result.data["sync"]["uploaded"].is_number(),
            "the cycle after the failure completed"
        );
        assert!(
            started.elapsed() >= Duration::from_secs(1),
            "the retry waited a poll interval rather than hammering the archive"
        );
        server.join().unwrap();
        assert!(!requests.lock().unwrap().is_empty());
    }

    /// Retrying forever is its own failure. A credential the archive refuses is
    /// not going to start working, and a watch that keeps asking every five
    /// minutes hides that from whoever has to fix it.
    #[test]
    fn a_refused_credential_ends_a_watch_but_a_dead_network_does_not() {
        assert!(fatal_for_watch(&AppError::network(problem_message(
            401, ""
        ))));
        assert!(fatal_for_watch(&AppError::network(problem_message(
            403, ""
        ))));
        assert!(fatal_for_watch(&AppError::usage("no such source")));
        assert!(fatal_for_watch(&AppError::internal("queue is corrupt")));
        assert!(!fatal_for_watch(&AppError::network(
            "error sending request: connection refused"
        )));
        assert!(!fatal_for_watch(&AppError::network(problem_message(
            503, ""
        ))));
        assert!(
            !fatal_for_watch(&AppError::locked("database is locked")),
            "another process holding the queue is a wait, not a stop"
        );
    }

    /// The download deadline has to be reachable for the largest bundle the
    /// materializer will accept.
    ///
    /// reqwest's blocking client caps a whole request at 30 seconds by default,
    /// and `ApiClient` took that default on every request including this one.
    /// At the slowest uplink the upload path is budgeted for, 30 seconds buys
    /// about 7.5 MB, so every non-trivial `memoar convert --here` failed on a
    /// deadline it could never meet, with no retry. This fails if the budget
    /// drops or the size ceiling rises without the other moving too.
    #[test]
    fn the_download_deadline_is_reachable_at_the_size_ceiling() {
        let on_the_wire =
            MAX_CONVERSION_BUNDLE_BYTES * BASE64_EXPANSION_NUMERATOR / BASE64_EXPANSION_DENOMINATOR;
        let needed = on_the_wire / SLOWEST_TOLERATED_BYTES_PER_SEC;
        assert!(
            DOWNLOAD_TIMEOUT.as_secs() >= needed,
            "a {MAX_CONVERSION_BUNDLE_BYTES}-byte bundle is {on_the_wire} bytes base64 and \
             needs {needed}s at the slowest tolerated uplink, but downloads are cut off after {}s",
            DOWNLOAD_TIMEOUT.as_secs()
        );
        assert!(
            CONNECT_TIMEOUT < REQUEST_TIMEOUT && REQUEST_TIMEOUT < DOWNLOAD_TIMEOUT,
            "an unreachable host must fail long before a slow download does"
        );
    }

    /// And the budget must actually reach the request that needs it.
    #[test]
    fn a_bundle_download_is_not_held_to_the_control_plane_budget() {
        let bundle = json!({ "contractVersion": "unreadable" });
        let (endpoint, _requests, _server) = spawn_mock(MockOptions {
            request_count: 1,
            conversion_bundle: Some(bundle),
            slow_path: "/download",
            slow_by: Duration::from_millis(900),
            ..MockOptions::default()
        });
        let api = ApiClient::with_timeouts(
            &endpoint,
            None,
            Duration::from_millis(400),
            Duration::from_secs(10),
        );

        // The bundle is deliberately not a bundle: what is being tested is that
        // the bytes arrived at all, not what they say.
        let outcome = api.download_conversion("/convert/conversion-job/download");
        assert!(
            !matches!(&outcome, Err(error) if error.message.contains("timed out")),
            "the download was held to the control-plane budget: {outcome:?}"
        );

        let (endpoint, _requests, _server) = spawn_mock(MockOptions {
            request_count: 1,
            slow_path: "/machines",
            slow_by: Duration::from_millis(900),
            ..MockOptions::default()
        });
        let api = ApiClient::with_timeouts(
            &endpoint,
            None,
            Duration::from_millis(400),
            Duration::from_secs(10),
        );
        let error = api
            .get("/machines")
            .expect_err("a control request must keep the short budget");
        assert!(
            error.message.contains("timed out"),
            "unexpected failure: {error:?}"
        );
    }

    /// "error sending request for url (…)" is not something an operator can act
    /// on. Behind a TLS-inspecting proxy it was the whole message: the URL, and
    /// nothing about the certificate. The reason is in the source chain.
    #[test]
    fn a_transport_failure_says_why() {
        let endpoint = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/v1", listener.local_addr().unwrap())
        };
        let error = ApiClient::new(&endpoint, None)
            .get("/machines")
            .expect_err("nothing is listening on that port");
        assert!(
            error.message.to_lowercase().contains("refused"),
            "the reason was dropped with the source chain: {}",
            error.message
        );
    }

    /// Redaction was writable at `login` and nowhere else: a CLI user who forgot
    /// the flags had to delete their configuration and sign in again, and the
    /// desktop app passed all three as false with nothing anywhere to change
    /// them.
    #[test]
    fn redaction_is_changeable_after_login() {
        let temp = tempfile::tempdir().unwrap();
        let paths = configured_paths(&temp, "http://127.0.0.1:1/v1");
        assert!(!load_config(&paths).unwrap().redaction.secrets);

        let output = redaction(
            &RedactionArgs {
                secrets: Some(true),
                email_addresses: None,
                home_paths: None,
            },
            &paths,
        )
        .unwrap();

        assert_eq!(output.data["changed"], true);
        assert_eq!(output.data["redaction"]["secrets"], true);
        let stored = load_config(&paths).unwrap().redaction;
        assert!(stored.secrets, "the setting must survive the process");
        assert!(
            !stored.email_addresses && !stored.home_paths,
            "a flag left off leaves that setting alone"
        );
        // Reading is not writing: asking what the settings are must not change
        // them or rewrite the file.
        let shown = redaction(
            &RedactionArgs {
                secrets: None,
                email_addresses: None,
                home_paths: None,
            },
            &paths,
        )
        .unwrap();
        assert_eq!(shown.data["changed"], false);
        assert_eq!(shown.data["redaction"]["secrets"], true);
    }

    /// A symlinked session store is skipped by discovery without a word, while
    /// `detected` follows the link and says the source is there. So `status`
    /// reported a source it was capturing nothing from, and nothing anywhere
    /// said why.
    #[test]
    fn status_and_doctor_name_a_source_behind_a_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let (endpoint, _requests, server) = spawn_mock_api(3, None);
        let paths = configured_paths(&temp, &endpoint);
        let external = temp.path().join("external-volume/projects");
        fs::create_dir_all(external.join("a-project")).unwrap();
        fs::write(external.join("a-project/session.jsonl"), b"{}\n").unwrap();
        fs::create_dir_all(paths.home.join(".claude")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&external, paths.home.join(".claude/projects")).unwrap();

        let status = status(&paths).unwrap();
        let skipped = status.data["skippedSymlinks"].as_array().unwrap().clone();
        assert_eq!(skipped.len(), 1, "one source is behind a link: {skipped:?}");
        assert_eq!(skipped[0]["source"], "claude-code");
        assert_eq!(
            skipped[0]["path"],
            json!(paths.home.join(".claude/projects"))
        );
        assert!(
            status.data["detectedSources"].as_u64().unwrap() > 0,
            "the source still reads as detected, which is exactly the lie"
        );

        let doctor = doctor(&paths).unwrap();
        server.join().unwrap();
        let check = doctor.data["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["name"] == "source_symlinks")
            .expect("doctor must report it");
        assert_eq!(check["ok"], false);
        assert!(
            check["detail"]
                .as_str()
                .unwrap()
                .contains(".claude/projects"),
            "the check must name the path: {check}"
        );
        assert_eq!(doctor.data["ok"], false);
    }

    #[test]
    fn http_search_view_and_pack_use_authenticated_api() {
        let (endpoint, requests, server) = spawn_mock_api(3, None);
        let temp = tempfile::tempdir().unwrap();
        let paths = configured_paths(&temp, &endpoint);
        search(
            &SearchArgs {
                query: "queue bug".to_owned(),
                mode: "hybrid".to_owned(),
                limit: 5,
                agent: None,
                workspace: None,
            },
            &paths,
        )
        .unwrap();
        view(
            &ViewArgs {
                session_id: "session".to_owned(),
                chunk_size: 50,
                cursor: None,
            },
            &paths,
        )
        .unwrap();
        pack(
            &PackArgs {
                query: "queue bug".to_owned(),
                max_tokens: 1000,
                max_evidence: 4,
                max_sessions: 2,
                max_excerpt_chars: 1000,
                freshness_policy: "mixed".to_owned(),
                stale_after_days: None,
            },
            &paths,
        )
        .unwrap();
        server.join().unwrap();
        assert!(
            requests
                .lock()
                .unwrap()
                .iter()
                .all(|request| request.headers.contains("authorization: Bearer user-token"))
        );
    }

    #[test]
    fn http_convert_here_downloads_verified_bundle_and_writes_locally() {
        let content = b"hello\n";
        let mut bundle = ConversionBundle {
            contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
            bundle_version: "1".to_owned(),
            bundle_sha256: String::new(),
            target: Target::ClaudeCode,
            session_id: MACHINE_ID.to_owned(),
            files: vec![memoar_materializer::BundleFile {
                path: format!("~/.claude/projects/-fixture/{MACHINE_ID}.jsonl"),
                media_type: "application/x-ndjson".to_owned(),
                base64: "aGVsbG8K".to_owned(),
                sha256: memoar_materializer::content_sha256(content),
                size: content.len() as u64,
            }],
            resume_command: format!("claude -r {MACHINE_ID}"),
            report: json!({"mappedTurns": 1, "degradedBlocks": 0, "droppedBlocks": 0}),
        };
        bundle.bundle_sha256 = memoar_materializer::bundle_sha256(&bundle).unwrap();
        let (endpoint, _requests, server) =
            spawn_mock_api(2, Some(serde_json::to_value(&bundle).unwrap()));
        let temp = tempfile::tempdir().unwrap();
        let paths = configured_paths(&temp, &endpoint);
        let result = convert(
            &ConvertArgs {
                session_id: MACHINE_ID.to_owned(),
                target: "claude-code".to_owned(),
                fallback: "fail".to_owned(),
                here: true,
                bundle: None,
                wait_seconds: 1,
                poll_milliseconds: 25,
            },
            &paths,
        )
        .unwrap();
        server.join().unwrap();
        let written = result.data["written"][0].as_str().unwrap();
        assert_eq!(fs::read(written).unwrap(), content);
    }
}

/// One decoded Server-Sent Event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerEvent {
    pub event: String,
    pub data: String,
}

/// Incrementally decodes an SSE byte stream into events.
///
/// The server sends `event:`/`data:` pairs terminated by a blank line, plus
/// periodic `ping` events. Frames can be split across chunks, so the decoder
/// keeps a buffer between reads.
#[derive(Debug, Default)]
pub struct SseDecoder {
    buffer: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a chunk and returns every complete event it produced.
    pub fn push(&mut self, chunk: &str) -> Vec<ServerEvent> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let frame: String = self.buffer.drain(..index + 2).collect();
            if let Some(event) = Self::decode_frame(frame.trim_end_matches('\n')) {
                events.push(event);
            }
        }
        events
    }

    fn decode_frame(frame: &str) -> Option<ServerEvent> {
        let mut event = String::from("message");
        let mut data = String::new();
        for line in frame.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                event = value.trim().to_owned();
            } else if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value.trim_start());
            }
        }
        if data.is_empty() {
            return None;
        }
        Some(ServerEvent { event, data })
    }
}
