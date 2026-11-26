//! The list pane (sessions or search results) and the transcript pane.

use chrono::{DateTime, Local, Utc};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Wrap};

use super::list;
use super::pane::frame_pane;
use crate::tui::app::{App, Screen, SearchFocus, SessionList};
use crate::tui::layout::{list_rows, transcript_text};
use crate::tui::model::{ListLine, grouped, plural};
use crate::tui::style;
use crate::tui::text::truncate;

pub(super) fn list(frame: &mut Frame, app: &App, pane: Rect, focused: bool) {
    if app.list_screen() == Screen::Search {
        search(frame, app, pane, focused);
    } else {
        sessions(frame, app, pane, focused);
    }
}

/// The lines of the session list, grouped by day. Shared with `mouse`.
pub(crate) fn session_lines(app: &App) -> Vec<ListLine> {
    grouped(&app.sessions.rows, Local::now().date_naive())
}

pub(crate) fn search_lines(app: &App) -> Vec<ListLine> {
    (0..app.search.results.rows.len())
        .map(ListLine::Session)
        .collect()
}

fn sessions(frame: &mut Frame, app: &App, pane: Rect, focused: bool) {
    let list = &app.sessions;
    let mut facts = vec![count(list)];
    if let Some(saved) = &list.cached_at {
        facts.push(format!("cached {}", when(saved)));
    }
    if list.loading {
        facts.push("loading".to_owned());
    }
    let inner = frame_pane(frame, pane, "Sessions", &facts, focused);
    if list.rows.is_empty() {
        let sentence = if list.loading {
            "Loading sessions."
        } else if app.offline {
            "The archive cannot be reached and nothing is cached yet. Press r to try again."
        } else {
            "No sessions yet. Run `memoar sync` to capture this computer's sessions."
        };
        empty(frame, inner, sentence);
        return;
    }
    list::draw(
        frame,
        app,
        list,
        &session_lines(app),
        list_rows(pane, Screen::Sessions),
        focused,
    );
}

fn search(frame: &mut Frame, app: &App, pane: Rect, focused: bool) {
    let search = &app.search;
    let results = &search.results;
    let mut facts = Vec::new();
    if search.query.is_some() && !results.loading {
        facts.push(count(results));
    }
    if let Some(mode) = &search.realized_mode {
        facts.push(mode.clone());
    }
    if results.loading {
        facts.push("searching".to_owned());
    }
    let inner = frame_pane(frame, pane, "Search", &facts, focused);
    let editing = search.focus == SearchFocus::Input && focused;
    let prompt = Span::styled(
        " / ",
        if editing {
            style::accent()
        } else {
            style::dim()
        },
    );
    let mut spans = vec![prompt, Span::raw(search.input.clone())];
    if editing {
        spans.push(Span::styled(style::glyphs().cursor, style::accent()));
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)),
        Rect { height: 1, ..inner },
    );
    let rows = list_rows(pane, Screen::Search);
    if results.rows.is_empty() {
        let sentence = match (&search.query, &search.error) {
            (_, Some(error)) => error.as_str(),
            (None, None) => "Type what to look for and press enter.",
            (Some(_), None) if results.loading => "Searching.",
            (Some(_), None) => "Nothing matches. Try other words.",
        };
        empty(frame, rows, sentence);
        return;
    }
    list::draw(
        frame,
        app,
        results,
        &search_lines(app),
        rows,
        focused && !editing,
    );
}

pub(super) fn transcript(frame: &mut Frame, app: &App, pane: Rect, focused: bool) {
    let Some(view) = &app.transcript else {
        let inner = frame_pane(frame, pane, "Transcript", &[], focused);
        empty(frame, inner, "Select a session to read it here.");
        return;
    };
    let session = &view.session;
    let mut facts = Vec::new();
    if app.converting.contains(&session.id) {
        facts.push("converting".to_owned());
    }
    if view.loading {
        facts.push("loading".to_owned());
    }
    if app.show_thinking {
        facts.push("thinking shown".to_owned());
    }
    let inner = frame_pane(frame, pane, &session.title, &facts, focused);
    let separator = format!(" {} ", style::glyphs().separator);
    let mut meta = vec![session.source_label.clone()];
    meta.extend(
        [session.project(), session.machine(&app.machines)]
            .into_iter()
            .filter(|part| !part.is_empty())
            .map(str::to_owned),
    );
    if let Some(at) = session.updated_at {
        meta.push(when_utc(at));
    }
    meta.push(plural(session.turn_count, "turn", "turns"));
    // The agent's mark in its colour, then the facts in dim.
    let mark = format!(" {} ", style::glyphs().dot);
    let text = truncate(
        &meta.join(&separator),
        usize::from(inner.width).saturating_sub(crate::tui::text::width(&mark)),
    );
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(mark, style::agent(&session.source)),
            Span::styled(text, style::dim()),
        ])),
        Rect { height: 1, ..inner },
    );
    let area = transcript_text(pane);
    let body = view.rendered(area.width, app.show_thinking);
    if body.is_empty() {
        let sentence = match &view.error {
            Some(error) => error.as_str(),
            None if view.loading => "Loading the transcript.",
            None => "This session has no turns.",
        };
        empty(frame, area, sentence);
        return;
    }
    let height = usize::from(area.height);
    let max = body.len().saturating_sub(height);
    let scroll = (view.shown.get().round().max(0.0) as usize).min(max);
    let mut shown: Vec<Line> = body.iter().skip(scroll).take(height).cloned().collect();
    if view.loading && shown.len() < height {
        shown.push(Line::styled("  loading more", style::dim()));
    }
    frame.render_widget(Paragraph::new(shown), area);
    scrollbar(frame, pane, scroll, height, body.len(), focused);
}

/// A thumb on the right border showing where in the transcript the view is.
fn scrollbar(
    frame: &mut Frame,
    pane: Rect,
    scroll: usize,
    height: usize,
    length: usize,
    focused: bool,
) {
    let track = usize::from(pane.height.saturating_sub(2));
    if length <= height || track == 0 {
        return;
    }
    let thumb = (track * height / length).clamp(1, track);
    let top = (track - thumb) * scroll / length.saturating_sub(height).max(1);
    let x = pane.x + pane.width - 1;
    let thumb_style = if focused {
        style::accent()
    } else {
        style::dim()
    };
    let symbol = style::glyphs().thumb;
    for offset in 0..thumb {
        let y = pane.y + 1 + (top + offset) as u16;
        if let Some(cell) = frame.buffer_mut().cell_mut((x, y)) {
            cell.set_symbol(symbol).set_style(thumb_style);
        }
    }
}

fn empty(frame: &mut Frame, area: Rect, sentence: &str) {
    // A column in from the border, on every wrapped line.
    let padded = Rect::new(
        area.x + 1,
        area.y,
        area.width.saturating_sub(2),
        area.height,
    );
    frame.render_widget(
        Paragraph::new(Line::styled(sentence.to_owned(), style::dim())).wrap(Wrap { trim: true }),
        padded,
    );
}

/// "240 of 1203 sessions" while more pages remain, else "1 session".
fn count(list: &SessionList) -> String {
    let loaded = list.rows.len() as u64;
    match list.total {
        Some(total) if total > loaded => {
            format!("{loaded} of {}", plural(total, "session", "sessions"))
        }
        _ => plural(loaded, "session", "sessions"),
    }
}

/// When the cache was saved, short enough for a pane title: the time today,
/// else the date.
fn when(rfc3339: &str) -> String {
    let Ok(at) = DateTime::parse_from_rfc3339(rfc3339) else {
        return String::new();
    };
    let at = at.with_timezone(&Local);
    if at.date_naive() == Local::now().date_naive() {
        at.format("%H:%M").to_string()
    } else {
        at.format("%-d %b").to_string()
    }
}

fn when_utc(at: DateTime<Utc>) -> String {
    at.with_timezone(&Local)
        .format("%-d %b %Y %H:%M")
        .to_string()
}
