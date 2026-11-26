//! The command palette (`:` or Ctrl-P): every action and every loaded
//! session, fuzzy matched as you type.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::action::{Action, perform};
use super::app::{App, Overlay, TARGETS};
use super::fuzzy::score;
use super::request::Request;

/// Rows the palette lists at most.
pub(crate) const MAX_ITEMS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Item {
    pub(crate) label: String,
    /// Secondary text: a session's source and project, an action's scope.
    pub(crate) detail: String,
    /// The key that does the same without the palette.
    pub(crate) key: &'static str,
    pub(crate) action: Action,
    /// Matched character positions in `label`, for highlighting.
    pub(crate) matched: Vec<usize>,
}

fn actions(app: &App) -> Vec<(String, &'static str, &'static str, Action)> {
    let session = app.focused_session().map(|row| row.title.clone());
    let mut out = vec![
        ("Search transcripts".to_owned(), "", "/", Action::Search),
        ("Capture status".to_owned(), "", "s", Action::Status),
        ("Refresh sessions".to_owned(), "", "r", Action::Refresh),
        (
            if app.show_thinking {
                "Hide thinking"
            } else {
                "Show thinking"
            }
            .to_owned(),
            "",
            "t",
            Action::ToggleThinking,
        ),
        ("Quit".to_owned(), "", "q", Action::Quit),
    ];
    if session.is_some() {
        for (target, label) in TARGETS {
            out.push((
                format!("Convert to {label}"),
                "write it here, resume there",
                "c",
                Action::Convert(target),
            ));
        }
        out.push((
            "Export session".to_owned(),
            "canonical JSON in this directory",
            "e",
            Action::Export,
        ));
        out.push(("Copy session id".to_owned(), "", "y", Action::CopyId));
        out.push(("Open transcript".to_owned(), "", "enter", Action::Open));
    }
    out
}

/// What the palette shows for `input`, best match first.
pub(crate) fn items(app: &App, input: &str) -> Vec<Item> {
    let mut scored: Vec<(i64, Item)> = Vec::new();
    for (label, detail, key, action) in actions(app) {
        if let Some((points, matched)) = score(input, &label) {
            // Actions first when the query is as good a match for both.
            scored.push((
                points + 2,
                Item {
                    label,
                    detail: detail.to_owned(),
                    key,
                    action,
                    matched,
                },
            ));
        }
    }
    for row in &app.sessions.rows {
        let haystack = format!("{} {} {}", row.title, row.project(), row.source_label);
        if let Some((points, matched)) = score(input, &haystack) {
            let title_length = row.title.chars().count();
            scored.push((
                points,
                Item {
                    label: row.title.clone(),
                    detail: format!(
                        "{} {} {}",
                        row.source_label,
                        crate::tui::style::glyphs().separator,
                        row.project()
                    ),
                    key: "",
                    action: Action::Jump(row.id.clone()),
                    matched: matched
                        .into_iter()
                        .filter(|index| *index < title_length)
                        .collect(),
                },
            ));
        }
    }
    // Stable, so an empty query keeps actions, then sessions newest first.
    scored.sort_by_key(|(points, _)| std::cmp::Reverse(*points));
    let mut items: Vec<Item> = scored
        .into_iter()
        .map(|(_, item)| item)
        .take(MAX_ITEMS)
        .collect();
    if !input.trim().is_empty() {
        items.push(Item {
            label: format!("Search the archive for \"{}\"", input.trim()),
            detail: String::new(),
            key: "",
            action: Action::SearchFor(input.trim().to_owned()),
            matched: Vec::new(),
        });
    }
    items
}

pub(crate) fn key(app: &mut App, key: KeyEvent) -> Vec<Request> {
    let Some(Overlay::Palette { input, selected }) = &mut app.overlay else {
        return Vec::new();
    };
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Esc => app.overlay = None,
        KeyCode::Down | KeyCode::Tab => *selected += 1,
        KeyCode::Char('n' | 'j') if control => *selected += 1,
        KeyCode::Up | KeyCode::BackTab => *selected = selected.saturating_sub(1),
        KeyCode::Char('p' | 'k') if control => *selected = selected.saturating_sub(1),
        KeyCode::Backspace => {
            input.pop();
            *selected = 0;
        }
        KeyCode::Char('u') if control => {
            input.clear();
            *selected = 0;
        }
        KeyCode::Char(character) if !control => {
            input.push(character);
            *selected = 0;
        }
        KeyCode::Enter => {
            let (input, selected) = (input.clone(), *selected);
            let found = items(app, &input);
            app.overlay = None;
            if let Some(item) = found.get(selected.min(found.len().saturating_sub(1))) {
                return perform(app, item.action.clone());
            }
        }
        _ => {}
    }
    // Keep the selection on a row that exists.
    let length = match &app.overlay {
        Some(Overlay::Palette { input, .. }) => items(app, input).len(),
        _ => return Vec::new(),
    };
    if let Some(Overlay::Palette { selected, .. }) = &mut app.overlay {
        *selected = (*selected).min(length.saturating_sub(1));
    }
    Vec::new()
}
