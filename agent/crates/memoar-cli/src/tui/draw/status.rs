//! `s`: what `memoar status` reports, as a definition list.
//!
//! The background service is optional. Without one, capture is a sentence
//! saying how to start it, not an error.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use serde_json::Value;

use super::pane::frame_pane;
use crate::tui::app::App;
use crate::tui::model::plural;
use crate::tui::render::wrap;
use crate::tui::style;

const LABEL: usize = 12;

pub(super) fn draw(frame: &mut Frame, app: &App, pane: Rect) {
    let status = &app.status;
    let facts = if status.loading {
        vec!["loading".to_owned()]
    } else {
        Vec::new()
    };
    let inner = frame_pane(frame, pane, "Capture status", &facts, true);
    let Some(data) = &status.data else {
        let sentence = status.error.as_deref().unwrap_or("Reading the status.");
        frame.render_widget(
            Paragraph::new(Line::styled(format!(" {sentence}"), style::dim())),
            inner,
        );
        return;
    };
    let columns = usize::from(inner.width);
    let mut out = Vec::new();
    for (label, value, value_style) in rows(app, data) {
        let prefix = vec![Span::styled(format!(" {label:<LABEL$}"), style::dim())];
        let mut lines = wrap::words(&[(value, value_style)], columns, &prefix);
        for line in lines.iter_mut().skip(1) {
            line.spans[0] = Span::raw(" ".repeat(LABEL + 1));
        }
        out.extend(lines);
    }
    frame.render_widget(Paragraph::new(out), inner);
}

fn rows(app: &App, data: &Value) -> Vec<(&'static str, String, ratatui::style::Style)> {
    let text = |pointer: &str| {
        data.pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let number = |pointer: &str| data.pointer(pointer).and_then(Value::as_u64).unwrap_or(0);
    let health = &data["backgroundCapture"];
    let state = health["state"].as_str().unwrap_or_default();
    let capture_style = match (state, health["ok"].as_bool()) {
        (_, Some(true)) => style::added(),
        // No service and no sync running: the service is optional, so this
        // is advice rather than a fault.
        ("not_running", _) => style::plain(),
        _ => style::removed(),
    };
    let mut rows = vec![("Capture", text("/backgroundCapture/summary"), capture_style)];
    if let Some(hint) = health["hint"].as_str() {
        rows.push(("", hint.to_owned(), style::dim()));
    }
    let service = &data["service"];
    let service_text = if service["installed"].as_bool() == Some(true) {
        let running = match service["running"].as_bool() {
            Some(true) => "running",
            Some(false) => "not running",
            None => "state unknown",
        };
        format!(
            "{}, {running} ({})",
            service["name"].as_str().unwrap_or("installed"),
            text("/service/manager")
        )
    } else {
        "not installed. It is optional: `memoar sync --watch` or `memoar service install` keeps capture running.".to_owned()
    };
    rows.push(("Service", service_text, style::plain()));
    rows.push(("Archive", text("/endpoint"), style::plain()));
    let machine = text("/machineId");
    let machine = match app.machines.get(&machine) {
        Some(name) => format!("{name} ({machine})"),
        None => machine,
    };
    rows.push(("Machine", machine, style::plain()));
    rows.push((
        "Queue",
        format!(
            "{} waiting, {} retrying, {} uploaded, {} held by the capture policy",
            number("/queue/pending"),
            number("/queue/retry"),
            number("/queue/synced"),
            number("/queue/held")
        ),
        style::plain(),
    ));
    let disk_style = if data.pointer("/disk/ok").and_then(Value::as_bool) == Some(false) {
        style::removed()
    } else {
        style::plain()
    };
    rows.push(("Disk", text("/disk/detail"), disk_style));
    rows.push((
        "Sources",
        format!(
            "{} of {} detected",
            number("/detectedSources"),
            plural(number("/sourceCount"), "source", "sources")
        ),
        style::plain(),
    ));
    let redaction: Vec<&str> = [
        ("secrets", "secrets"),
        ("emailAddresses", "email addresses"),
        ("homePaths", "home paths"),
    ]
    .into_iter()
    .filter(|(key, _)| data["redaction"][key].as_bool() == Some(true))
    .map(|(_, label)| label)
    .collect();
    rows.push((
        "Redaction",
        if redaction.is_empty() {
            "off".to_owned()
        } else {
            redaction.join(", ")
        },
        style::plain(),
    ));
    rows
}
