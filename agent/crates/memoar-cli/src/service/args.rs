use clap::{Args, Subcommand};

#[derive(Debug, Subcommand)]
pub enum ServiceCommand {
    /// Install and start a per-user service that runs `memoar sync --watch`
    /// at login, restarts it after a failure, and logs to the data directory.
    /// Running it again rewrites the service and restarts it.
    Install(ServiceChangeArgs),
    /// Stop and remove the service.
    Uninstall(ServiceChangeArgs),
    /// Whether the service is installed and running, and whether capture is.
    Status(ServiceNameArgs),
    /// Print the end of the background capture log in the data directory.
    Logs(ServiceLogsArgs),
    /// What the installed service runs: `sync --watch`, restarted with backoff.
    #[command(hide = true)]
    Run(ServiceNameArgs),
}

#[derive(Debug, Args)]
pub struct ServiceNameArgs {
    /// Which service. Defaults to the one installed for this configuration,
    /// else `agent`. A second name runs a second service, for a second
    /// configuration directory.
    #[arg(long)]
    pub name: Option<String>,
}

#[derive(Debug, Args)]
pub struct ServiceChangeArgs {
    #[command(flatten)]
    pub service: ServiceNameArgs,
    /// Replace or remove a service of this name that was installed for
    /// another configuration directory.
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct ServiceLogsArgs {
    /// How many lines to print from the end of the log.
    #[arg(long, default_value_t = 50)]
    pub lines: usize,
}
