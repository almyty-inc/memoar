//! The arguments of `sync` and `policy`: what capture takes, and how it sends it.

use clap::Args;

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
    /// Report what a capture would take, per source and project, and stop.
    /// Reads no session in full, queues nothing and uploads nothing.
    #[arg(long, conflicts_with = "watch")]
    pub plan: bool,
    /// Capture sessions modified since this, for this run only: `all`, a date
    /// (2026-01-31), or a duration (30d, 8w, 36h). `memoar policy --since`
    /// keeps a setting.
    #[arg(long, value_name = "WHEN")]
    pub since: Option<String>,
    /// Uploads in flight at once.
    #[arg(long, default_value_t = 4, value_parser = clap::value_parser!(u16).range(1..=16))]
    pub workers: u16,
    /// The most uploads started in a minute. The archive allows 300 a minute
    /// per route by default. 0 does not pace.
    #[arg(long, default_value_t = 280)]
    pub uploads_per_minute: u32,
}

impl Default for SyncArgs {
    fn default() -> Self {
        Self {
            watch: false,
            interval_seconds: 2,
            debounce_seconds: 2,
            max_cycles: 0,
            plan: false,
            since: None,
            workers: 4,
            uploads_per_minute: 280,
        }
    }
}

/// What `policy` can change. A flag left off leaves that part alone.
#[derive(Debug, Args, Default)]
pub struct PolicyArgs {
    /// How far back capture reaches: `all`, a date, an RFC 3339 instant, a
    /// duration such as 90d (rolling), or `default` for the first-run window.
    #[arg(long, value_name = "WHEN")]
    pub since: Option<String>,
    /// Capture only workspaces matching this glob. Repeatable.
    #[arg(long, value_name = "GLOB")]
    pub include: Vec<String>,
    /// Leave out workspaces matching this glob, such as '/private/tmp/**' or
    /// '**/.claude/worktrees/**'. Repeatable.
    #[arg(long, value_name = "GLOB")]
    pub exclude: Vec<String>,
    /// Remove a glob from both lists. Repeatable.
    #[arg(long, value_name = "GLOB")]
    pub remove: Vec<String>,
    /// Free space capture keeps on the data directory's volume, such as 5GiB,
    /// or `default` for 5% of the volume kept between 2 GiB and 10 GiB.
    #[arg(long, value_name = "SIZE")]
    pub min_free: Option<String>,
}
