//! Which artifacts a capture takes: how far back, and from which projects.
//!
//! A first sync on a machine with 244,111 Claude Code sessions tried to take
//! every one of them. The policy bounds that. An artifact last modified before
//! `since` is left where it is, and so is one whose workspace an `exclude`
//! pattern names, or no `include` pattern does.

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePolicy {
    /// Artifacts last modified before this are not captured. `None` takes all.
    pub since: Option<DateTime<Utc>>,
    /// Workspace globs to keep. Empty keeps every workspace.
    pub include: Vec<String>,
    /// Workspace globs to drop, checked after `include`.
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Capture,
    TooOld,
    Excluded,
}

impl CapturePolicy {
    /// Everything, from every project: what capture did before the policy.
    #[must_use]
    pub fn everything() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn has_project_rules(&self) -> bool {
        !self.include.is_empty() || !self.exclude.is_empty()
    }

    #[must_use]
    pub fn by_age(&self, modified: DateTime<Utc>) -> Verdict {
        match self.since {
            Some(since) if modified < since => Verdict::TooOld,
            _ => Verdict::Capture,
        }
    }

    /// An artifact whose workspace is not known is kept: an `include` list is
    /// about projects, and a Cursor state database belongs to none.
    #[must_use]
    pub fn by_project(&self, workspace: Option<&str>) -> Verdict {
        let Some(workspace) = workspace else {
            return Verdict::Capture;
        };
        let included = self.include.is_empty()
            || self
                .include
                .iter()
                .any(|pattern| workspace_matches(pattern, workspace));
        let excluded = self
            .exclude
            .iter()
            .any(|pattern| workspace_matches(pattern, workspace));
        if included && !excluded {
            Verdict::Capture
        } else {
            Verdict::Excluded
        }
    }

    #[must_use]
    pub fn judge(&self, modified: DateTime<Utc>, workspace: Option<&str>) -> Verdict {
        match self.by_age(modified) {
            Verdict::Capture => self.by_project(workspace),
            other => other,
        }
    }
}

/// Reads a backfill bound: `all`, a date (`2026-01-31`), an RFC 3339 instant,
/// or a duration back from `now` in hours, days or weeks (`36h`, `30d`, `8w`).
/// `Ok(None)` is `all`.
pub fn parse_since(text: &str, now: DateTime<Utc>) -> Result<Option<DateTime<Utc>>, String> {
    let text = text.trim();
    if text.eq_ignore_ascii_case("all") {
        return Ok(None);
    }
    if let Ok(instant) = DateTime::parse_from_rfc3339(text) {
        return Ok(Some(instant.with_timezone(&Utc)));
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Ok(Some(date.and_time(chrono::NaiveTime::MIN).and_utc()));
    }
    let split = text.len().saturating_sub(1);
    let (count, unit) = text.split_at(split);
    let count: i64 = count.parse().map_err(|_| unreadable(text))?;
    let span = match unit {
        "h" => Duration::try_hours(count),
        "d" => Duration::try_days(count),
        "w" => Duration::try_weeks(count),
        _ => None,
    }
    .filter(|_| count >= 0)
    .ok_or_else(|| unreadable(text))?;
    Ok(Some(now - span))
}

fn unreadable(text: &str) -> String {
    format!(
        "{text:?} is not a backfill bound: use all, a date such as 2026-01-31, or a duration such as 30d, 8w or 36h"
    )
}

/// Whether a workspace path is named by a pattern.
///
/// `*` and `?` stay within one path segment and `**` spans any number of them,
/// so `/private/tmp/**` is everything under that directory and
/// `**/worktrees/**` is any worktree anywhere. A pattern with no wildcard names
/// a directory and everything beneath it. Backslashes are read as slashes, so
/// one pattern serves a Windows path too.
#[must_use]
pub fn workspace_matches(pattern: &str, workspace: &str) -> bool {
    let pattern = pattern.replace('\\', "/");
    let workspace = workspace.replace('\\', "/");
    let pattern = pattern.trim_end_matches('/');
    let workspace = workspace.trim_end_matches('/');
    if !pattern.contains(['*', '?']) {
        return workspace == pattern
            || workspace
                .strip_prefix(pattern)
                .is_some_and(|rest| rest.starts_with('/'));
    }
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = workspace.split('/').collect();
    segments_match(&pattern, &path)
}

fn segments_match(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| segments_match(rest, &path[skip..])),
        Some((first, rest)) => path.split_first().is_some_and(|(name, remaining)| {
            segment_matches(first.as_bytes(), name.as_bytes()) && segments_match(rest, remaining)
        }),
    }
}

fn segment_matches(pattern: &[u8], name: &[u8]) -> bool {
    match pattern.split_first() {
        None => name.is_empty(),
        Some((b'*', rest)) => (0..=name.len()).any(|skip| segment_matches(rest, &name[skip..])),
        Some((b'?', rest)) => !name.is_empty() && segment_matches(rest, &name[1..]),
        Some((byte, rest)) => name.first() == Some(byte) && segment_matches(rest, &name[1..]),
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
