use clap::{Args, Parser, Subcommand};
use memoar_connectors::{OperatingSystem, SOURCES, discover};
use memoar_daemon::{
    DaemonError, HttpTransport, OfflineQueue, PollingCapture, RedactionConfig, SyncEngine,
    capture_sources_with_redaction,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    access_token: String,
}

pub trait CredentialStore {
    fn load_token(&self) -> Result<Option<String>, AppError>;
    fn store_token(&self, token: &str) -> Result<(), AppError>;
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
    fn load_token(&self) -> Result<Option<String>, AppError> {
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
        if credentials.access_token.is_empty() {
            return Ok(None);
        }
        Ok(Some(credentials.access_token))
    }

    fn store_token(&self, token: &str) -> Result<(), AppError> {
        if token.is_empty() {
            return Err(AppError::usage("access token cannot be empty"));
        }
        let bytes = serde_json::to_vec(&Credentials {
            access_token: token.to_owned(),
        })
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
    let access_token =
        if let Some(token) = &args.token {
            if token.is_empty() {
                return Err(AppError::usage("--token cannot be empty"));
            }
            token.clone()
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
            auth.get("accessToken")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::network("login response did not include accessToken"))?
                .to_owned()
        };
    let api = ApiClient::new(endpoint, Some(&access_token));
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
    paths.credential_store().store_token(&access_token)?;
    save_config(paths, &config)?;
    OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    Ok(CommandOutput {
        command: "login".to_owned(),
        data: json!({
            "initialized": true,
            "endpoint": config.endpoint,
            "machineId": machine_id,
            "redaction": config.redaction
        }),
    })
}

fn status(paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let config = load_config(paths)?;
    let credentials = load_token(paths)?;
    let queue = OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    let counts = queue.counts().map_err(map_queue_error)?;
    let discovered = discover(&paths.home, OperatingSystem::current());
    Ok(CommandOutput {
        command: "status".to_owned(),
        data: json!({
            "initialized": true,
            "credentialsConfigured": !credentials.is_empty(),
            "endpoint": config.endpoint,
            "machineId": config.machine_id,
            "queue": counts,
            "redaction": config.redaction,
            "detectedSources": discovered.iter().filter(|source| source.detected).count(),
            "sourceCount": discovered.len()
        }),
    })
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
    let token = load_token(paths)?;
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
    let access_token = load_token(paths)?;
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
    let mut last = sync_pending(&queue, &config, &access_token, paths, captured)?;
    if args.watch {
        let mut watcher = PollingCapture::new(Duration::from_secs(args.debounce_seconds.max(1)));
        loop {
            println!(
                "captured {} artifacts, uploaded {}",
                last["captured"], last["sync"]["uploaded"]
            );
            thread::sleep(Duration::from_secs(args.interval_seconds.max(1)));
            let captured = watcher
                .scan(
                    &queue,
                    &paths.home,
                    OperatingSystem::current(),
                    &enabled,
                    config.redaction,
                    SystemTime::now(),
                )
                .map_err(map_capture_error)?;
            last = sync_pending(&queue, &config, &access_token, paths, captured)?;
        }
    }
    Ok(CommandOutput {
        command: "sync".to_owned(),
        data: last,
    })
}

fn enabled_sources(config: &Config) -> HashSet<String> {
    SOURCES
        .iter()
        .filter(|source| !config.disabled_sources.contains(source.id))
        .map(|source| source.id.to_owned())
        .collect()
}

fn sync_pending(
    queue: &OfflineQueue,
    config: &Config,
    access_token: &str,
    paths: &RuntimePaths,
    captured: usize,
) -> Result<Value, AppError> {
    let api = ApiClient::new(&config.endpoint, Some(access_token));
    patch_machine_state(&api, config, paths)?;
    let token = issue_machine_token(&api, &config.machine_id)?;
    let transport = HttpTransport::new(&config.endpoint, token);
    let report = SyncEngine::new(transport)
        .sync(queue, &config.machine_id)
        .map_err(map_sync_error)?;
    Ok(json!({ "captured": captured, "sync": report }))
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
    let machine_token = issue_machine_token(&api, &config.machine_id)?;
    let machine_api = ApiClient::new(&config.endpoint, Some(&machine_token));

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
    let access_token = load_token(paths)?;
    let queue = OfflineQueue::open(&paths.queue_file()).map_err(map_queue_error)?;
    let database_ok = queue.integrity_check().map_err(map_queue_error)?;
    let api = ApiClient::new(&config.endpoint, Some(&access_token));
    verify_machine(&api, &config.machine_id)?;
    let machine_token = issue_machine_token(&api, &config.machine_id)?;
    patch_machine_state(&api, &config, paths)?;
    let checks = vec![
        json!({ "name": "contract_version", "ok": config.contract_version == memoar_canonical::CONTRACT_VERSION, "detail": config.contract_version }),
        json!({ "name": "queue_integrity", "ok": database_ok, "detail": paths.queue_file() }),
        json!({ "name": "credentials", "ok": !access_token.is_empty(), "detail": "credential store contains a token" }),
        json!({ "name": "source_table", "ok": !SOURCES.is_empty(), "detail": format!("{} sources", SOURCES.len()) }),
        json!({ "name": "api_reachable", "ok": true, "detail": config.endpoint }),
        json!({ "name": "machine_registered", "ok": true, "detail": config.machine_id }),
        json!({ "name": "machine_token", "ok": !machine_token.is_empty(), "detail": "machine token issued" }),
    ];
    let ok = checks.iter().all(|check| check["ok"] == Value::Bool(true));
    Ok(CommandOutput {
        command: "doctor".to_owned(),
        data: json!({ "ok": ok, "checks": checks }),
    })
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

fn issue_machine_token(api: &ApiClient, machine_id: &str) -> Result<String, AppError> {
    let response = api.post("/auth/machine-token", &json!({ "machineId": machine_id }))?;
    response
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::network("machine token response did not include token"))
}

fn validate_uuid_v7(label: &str, value: &str) -> Result<(), AppError> {
    let id = Uuid::parse_str(value)
        .map_err(|error| AppError::network(format!("invalid {label}: {error}")))?;
    if id.get_version_num() != 7 {
        return Err(AppError::network(format!("{label} is not UUIDv7")));
    }
    Ok(())
}

fn authenticated_config(paths: &RuntimePaths) -> Result<(Config, String), AppError> {
    Ok((load_config(paths)?, load_token(paths)?))
}

fn load_token(paths: &RuntimePaths) -> Result<String, AppError> {
    paths
        .credential_store()
        .load_token()?
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

struct ApiClient {
    client: Client,
    endpoint: String,
    token: Option<String>,
}

impl ApiClient {
    fn new(endpoint: &str, token: Option<&str>) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("static HTTP client configuration must be valid"),
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            token: token.map(str::to_owned),
        }
    }

    fn authorize(&self, request: RequestBuilder) -> RequestBuilder {
        if let Some(token) = &self.token {
            request.bearer_auth(token)
        } else {
            request
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
        let bytes = self.send_bytes(self.authorize(self.client.get(self.url(path))))?;
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
        let bytes = self.send_bytes(self.client.get(url))?;
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
            .map_err(|error| AppError::network(error.to_string()))
    }

    fn send(&self, request: RequestBuilder) -> Result<Response, AppError> {
        let response = request
            .send()
            .map_err(|error| AppError::network(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(AppError::network(format!("HTTP {status}: {body}")));
        }
        Ok(response)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoint, path)
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
            .store_token("secret-user-token")
            .unwrap();
        let config_text = fs::read_to_string(paths.config_file()).unwrap();
        assert!(!config_text.contains("secret-user-token"));
        assert_eq!(load_token(&paths).unwrap(), "secret-user-token");
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
            .store_token("secret-user-token")
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

    fn spawn_mock_api(
        request_count: usize,
        conversion_bundle: Option<Value>,
    ) -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<RecordedRequest>>>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let handle = std::thread::spawn(move || {
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
                write!(
                    stream,
                    "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                stream.write_all(&response).unwrap();
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
        paths.credential_store().store_token("user-token").unwrap();
        paths
    }

    #[test]
    fn http_login_registers_machine_and_doctor_validates_live_path() {
        let (endpoint, requests, server) = spawn_mock_api(6, None);
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
