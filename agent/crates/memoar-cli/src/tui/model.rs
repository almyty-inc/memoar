//! Session summaries as the TUI shows them, read from the archive's JSON.
//!
//! The commands hand back `serde_json::Value`, and the TUI reads only the
//! fields it draws. A summary missing a required field is skipped rather than
//! drawn with blanks.

use chrono::{DateTime, Local, NaiveDate, Utc};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SessionRow {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) source: String,
    pub(crate) source_label: String,
    pub(crate) workspace: String,
    pub(crate) machine_id: Option<String>,
    pub(crate) updated_at: Option<DateTime<Utc>>,
    pub(crate) turn_count: u64,
    pub(crate) highlight: Option<String>,
}

impl SessionRow {
    pub(crate) fn from_value(value: &Value) -> Option<Self> {
        let text = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
        let id = text("id")?;
        let source = text("source").unwrap_or_default();
        Some(Self {
            title: text("title")
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| "Untitled session".to_owned()),
            source_label: text("sourceLabel").unwrap_or_else(|| source.clone()),
            source,
            workspace: text("workspace").unwrap_or_default(),
            machine_id: text("machineId"),
            updated_at: text("updatedAt")
                .and_then(|at| DateTime::parse_from_rfc3339(&at).ok())
                .map(|at| at.with_timezone(&Utc)),
            turn_count: value.get("turnCount").and_then(Value::as_u64).unwrap_or(0),
            highlight: text("highlight").filter(|highlight| !highlight.trim().is_empty()),
            id,
        })
    }

    /// The last path component of the workspace, which is what tells two
    /// projects apart in a narrow column.
    pub(crate) fn project(&self) -> &str {
        self.workspace
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
    }

    pub(crate) fn local_date(&self) -> Option<NaiveDate> {
        self.updated_at
            .map(|at| at.with_timezone(&Local).date_naive())
    }

    pub(crate) fn time(&self) -> String {
        self.updated_at
            .map(|at| at.with_timezone(&Local).format("%H:%M").to_string())
            .unwrap_or_default()
    }

    pub(crate) fn machine<'a>(&self, machines: &'a HashMap<String, String>) -> &'a str {
        self.machine_id
            .as_ref()
            .and_then(|id| machines.get(id))
            .map_or("", String::as_str)
    }
}

/// Every summary in `items` that has an id.
pub(crate) fn rows(page: &Value) -> Vec<SessionRow> {
    page.get("items")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(SessionRow::from_value).collect())
        .unwrap_or_default()
}

pub(crate) fn next_cursor(page: &Value) -> Option<String> {
    page.get("nextCursor")
        .and_then(Value::as_str)
        .filter(|cursor| !cursor.is_empty())
        .map(str::to_owned)
}

/// `GET /machines` as id to name.
pub(crate) fn machine_names(page: &Value) -> HashMap<String, String> {
    page.get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|machine| {
            Some((
                machine.get("id")?.as_str()?.to_owned(),
                machine.get("name")?.as_str()?.to_owned(),
            ))
        })
        .collect()
}

/// "1 turn", "12 turns".
pub(crate) fn plural(count: u64, one: &str, many: &str) -> String {
    if count == 1 {
        format!("{count} {one}")
    } else {
        format!("{count} {many}")
    }
}

/// "Today", "Yesterday", or the date.
pub(crate) fn day_label(day: Option<NaiveDate>, today: NaiveDate) -> String {
    match day {
        None => "No date".to_owned(),
        Some(day) if day == today => "Today".to_owned(),
        Some(day) if today.pred_opt() == Some(day) => "Yesterday".to_owned(),
        Some(day) => day.format("%a %-d %b %Y").to_string(),
    }
}

/// One line of the grouped list: a day heading or a session, by index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ListLine {
    Day(String),
    Session(usize),
}

/// The sessions with a heading wherever the day changes. They arrive newest
/// first, so a day is one run of rows.
pub(crate) fn grouped(rows: &[SessionRow], today: NaiveDate) -> Vec<ListLine> {
    let mut lines = Vec::with_capacity(rows.len() + 8);
    let mut current: Option<Option<NaiveDate>> = None;
    for (index, row) in rows.iter().enumerate() {
        let day = row.local_date();
        if current != Some(day) {
            lines.push(ListLine::Day(day_label(day, today)));
            current = Some(day);
        }
        lines.push(ListLine::Session(index));
    }
    lines
}
