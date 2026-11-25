//! The capture policy in force, and `memoar policy`, which changes it.
//!
//! A first sync used to take everything a machine had ever recorded. Unless
//! told otherwise it now takes the last 30 days, counted from the first sync
//! on this data directory, and says how much older material it left behind.

use chrono::{Duration, Utc};
use memoar_daemon::{
    CapturePolicy, OfflineQueue, SpaceCheck, SpaceFloor, check_space, parse_since,
};
use serde_json::{Value, json};

use crate::CommandOutput;
use crate::args::PolicyArgs;
use crate::config::{CaptureSettings, Config, RuntimePaths, load_config, save_config};
use crate::error::{AppError, map_queue_error};

/// The first-run window. Long enough to hold the work somebody is in the
/// middle of, short enough that a machine with years of sessions does not
/// try to upload all of them before anyone has looked at what they are.
pub(crate) const DEFAULT_BACKFILL_DAYS: i64 = 30;

/// Where the `since` in force came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Origin {
    Flag,
    Config,
    Default,
}

impl Origin {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Origin::Flag => "flag",
            Origin::Config => "config",
            Origin::Default => "default",
        }
    }
}

/// The policy for this run. `queue` fixes the default window the first time
/// it is used, and without one the window is counted from now.
pub(crate) fn effective_policy(
    config: &Config,
    queue: Option<&OfflineQueue>,
    flag: Option<&str>,
) -> Result<(CapturePolicy, Origin), AppError> {
    let now = Utc::now();
    let read = |text: &str| parse_since(text, now).map_err(AppError::usage);
    let (since, origin) = match (flag, config.capture.since.as_deref()) {
        (Some(text), _) => (read(text)?, Origin::Flag),
        (None, Some(text)) => (read(text)?, Origin::Config),
        (None, None) => {
            let window = Duration::days(DEFAULT_BACKFILL_DAYS);
            let anchor = match queue {
                Some(queue) => queue.backfill_anchor(window).map_err(map_queue_error)?,
                None => now - window,
            };
            (Some(anchor), Origin::Default)
        }
    };
    Ok((
        CapturePolicy {
            since,
            include: config.capture.include.clone(),
            exclude: config.capture.exclude.clone(),
        },
        origin,
    ))
}

/// The floor in force: `MEMOAR_MIN_FREE_BYTES` when it is set and readable,
/// else the configured one, else the default rule. The variable is for a
/// machine whose floor an operator manages, and for test runners whose free
/// space nobody controls.
pub(crate) fn space_floor(config: &Config) -> SpaceFloor {
    std::env::var("MEMOAR_MIN_FREE_BYTES")
        .ok()
        .and_then(|value| parse_size(&value).ok())
        .or(config.capture.min_free_bytes)
        .map_or(SpaceFloor::default_rule(), SpaceFloor::exact)
}

/// The data directory's volume against the floor, for `status` and `doctor`.
pub(crate) fn disk_value(paths: &RuntimePaths, config: &Config) -> Value {
    match check_space(&paths.data_dir, space_floor(config), 0) {
        Ok(check) => disk_json(&check),
        Err(error) => json!({ "ok": null, "detail": error.to_string() }),
    }
}

/// The same, as one of `doctor`'s checks.
pub(crate) fn disk_check(paths: &RuntimePaths, config: &Config) -> Value {
    let disk = disk_value(paths, config);
    json!({
        "name": "disk_space",
        "ok": disk["ok"],
        "detail": disk["detail"],
        "disk": disk,
    })
}

pub(crate) fn disk_json(check: &SpaceCheck) -> Value {
    json!({
        "ok": check.ok,
        "path": check.path,
        "availableBytes": check.available_bytes,
        "totalBytes": check.total_bytes,
        "floorBytes": check.floor_bytes,
        "detail": format!(
            "{} free, capture keeps {} free",
            human_bytes(check.available_bytes),
            human_bytes(check.floor_bytes)
        ),
    })
}

pub(crate) fn policy_value(policy: &CapturePolicy, origin: Origin) -> Value {
    json!({
        "since": policy.since.map(|since| since.to_rfc3339()),
        "origin": origin.as_str(),
        "include": policy.include,
        "exclude": policy.exclude,
    })
}

/// `memoar policy`: changes what the flags name, then reports what is in force.
pub(crate) fn policy(args: &PolicyArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let mut config = load_config(paths)?;
    let before = config.capture.clone();
    apply(&mut config.capture, args)?;
    let changed = config.capture != before;
    if changed {
        save_config(paths, &config)?;
    }
    let queue = paths
        .queue_file()
        .exists()
        .then(|| OfflineQueue::open(&paths.queue_file()))
        .transpose()
        .map_err(map_queue_error)?;
    let (policy, origin) = effective_policy(&config, queue.as_ref(), None)?;
    Ok(CommandOutput {
        command: "policy".to_owned(),
        data: json!({
            "changed": changed,
            "policy": policy_value(&policy, origin),
            "minFreeBytes": config.capture.min_free_bytes,
            "disk": disk_value(paths, &config),
            "appliesFrom": "the next capture",
        }),
    })
}

fn apply(settings: &mut CaptureSettings, args: &PolicyArgs) -> Result<(), AppError> {
    if let Some(since) = &args.since {
        if since == "default" {
            settings.since = None;
        } else {
            parse_since(since, Utc::now()).map_err(AppError::usage)?;
            settings.since = Some(since.clone());
        }
    }
    for glob in &args.remove {
        settings.include.retain(|kept| kept != glob);
        settings.exclude.retain(|kept| kept != glob);
    }
    for (globs, list) in [
        (&args.include, &mut settings.include),
        (&args.exclude, &mut settings.exclude),
    ] {
        for glob in globs {
            if glob.trim().is_empty() {
                return Err(AppError::usage("an empty glob matches nothing"));
            }
            if !list.contains(glob) {
                list.push(glob.clone());
            }
        }
    }
    if let Some(size) = &args.min_free {
        settings.min_free_bytes = if size == "default" {
            None
        } else {
            Some(parse_size(size)?)
        };
    }
    Ok(())
}

/// `5GiB`, `500MB`, `2g`, or a plain number of bytes.
pub(crate) fn parse_size(text: &str) -> Result<u64, AppError> {
    let text = text.trim();
    let digits = text
        .find(|character: char| !(character.is_ascii_digit() || character == '.'))
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(digits);
    let number: f64 = number
        .parse()
        .map_err(|_| AppError::usage(format!("{text:?} is not a size such as 5GiB")))?;
    let scale: f64 = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1.0,
        "k" | "kb" => 1e3,
        "m" | "mb" => 1e6,
        "g" | "gb" => 1e9,
        "t" | "tb" => 1e12,
        "kib" => 1024.0,
        "mib" => 1024.0 * 1024.0,
        "gib" => 1024.0 * 1024.0 * 1024.0,
        "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        other => {
            return Err(AppError::usage(format!(
                "{other:?} is not a size unit: use B, KB, MB, GB, KiB, MiB or GiB"
            )));
        }
    };
    Ok((number * scale) as u64)
}

pub(crate) fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}
