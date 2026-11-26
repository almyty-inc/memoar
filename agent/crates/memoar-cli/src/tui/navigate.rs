//! Moving through lists and transcripts, and keeping the preview on the
//! selected session.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::app::{App, Screen, SessionList, Transcript};
use super::layout::{list_height, transcript_area};
use super::request::Request;

/// How close to the end of what is loaded the next page is asked for.
const PREFETCH: usize = 10;

/// Where a list key moves the selection, or `None` for a key that is not one.
pub(crate) fn list_target(list: &SessionList, key: KeyEvent, page: usize) -> Option<usize> {
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    let last = list.rows.len().saturating_sub(1);
    let selected = list.selected;
    let target = match key.code {
        KeyCode::Char('j') | KeyCode::Down => selected + 1,
        KeyCode::Char('k') | KeyCode::Up => selected.saturating_sub(1),
        KeyCode::Char('d') if control => selected + page / 2,
        KeyCode::Char('u') if control => selected.saturating_sub(page / 2),
        KeyCode::PageDown => selected + page,
        KeyCode::PageUp => selected.saturating_sub(page),
        KeyCode::Char('g') | KeyCode::Home => 0,
        KeyCode::Char('G') | KeyCode::End => last,
        _ => return None,
    };
    Some(target.min(last))
}

/// Selects row `index` of the current list, follows it with the preview,
/// and asks for the next page when the end comes near.
pub(crate) fn select(app: &mut App, index: usize) -> Vec<Request> {
    let list_screen = app.list_screen();
    let list = app.list_mut();
    if list.rows.is_empty() {
        return Vec::new();
    }
    list.selected = index.min(list.rows.len() - 1);
    let more = wants_more(list);
    follow(app);
    let query = app.search.query.clone().unwrap_or_default();
    more.map(|cursor| match list_screen {
        Screen::Search => Request::Search {
            query,
            cursor: Some(cursor),
        },
        _ => Request::Sessions {
            cursor: Some(cursor),
        },
    })
    .into_iter()
    .collect()
}

fn wants_more(list: &mut SessionList) -> Option<String> {
    if list.loading || list.selected + PREFETCH < list.rows.len() {
        return None;
    }
    let cursor = list.next_cursor.clone()?;
    list.loading = true;
    Some(cursor)
}

/// Points the preview at the selected session: from memory when it was read
/// before, else as a placeholder whose request waits for `fetch_preview`.
pub(crate) fn follow(app: &mut App) {
    let Some(row) = app.list().current().cloned() else {
        return;
    };
    if app
        .transcript
        .as_ref()
        .is_some_and(|view| view.session.id == row.id)
    {
        return;
    }
    if let Some(previous) = app.transcript.take() {
        app.viewed.insert(previous.session.id.clone(), previous);
    }
    let mut view = app
        .viewed
        .remove(&row.id)
        .unwrap_or_else(|| Transcript::pending(row));
    if view.turns.is_empty() && view.error.is_some() {
        // It failed before, perhaps offline. Coming back to it tries again.
        view.loading = true;
        view.requested = false;
    }
    view.shown.set(view.scroll as f32);
    app.preview_pending = view.loading && !view.requested;
    app.transcript = Some(view);
}

/// The request for the previewed session, once. The loop calls this when
/// the selection has rested, so holding `j` does not fetch every row.
pub(crate) fn fetch_preview(app: &mut App) -> Vec<Request> {
    app.preview_pending = false;
    let Some(view) = app.transcript.as_mut() else {
        return Vec::new();
    };
    if !view.loading || view.requested {
        return Vec::new();
    }
    view.requested = true;
    vec![Request::Transcript {
        session_id: view.session.id.clone(),
        cursor: None,
    }]
}

/// Enter: the selected session's transcript gets the keys.
pub(crate) fn open(app: &mut App) -> Vec<Request> {
    if app.list().current().is_none() {
        return Vec::new();
    }
    follow(app);
    app.push(Screen::Transcript);
    fetch_preview(app)
}

pub(crate) fn open_status(app: &mut App) -> Vec<Request> {
    app.push(Screen::Status);
    app.status.loading = true;
    vec![Request::Status]
}

/// How many lines the transcript is, and how many fit, at the current size.
pub(crate) fn transcript_extent(app: &App) -> (usize, usize) {
    let area = transcript_area(app);
    let length = app
        .transcript
        .as_ref()
        .map_or(0, |view| view.rendered(area.width, app.show_thinking).len());
    (length, usize::from(area.height).max(1))
}

/// Scrolls the transcript by keys, keeps it inside its length, and asks for
/// the next chunk when the end of what is loaded comes into view.
pub(crate) fn transcript_key(app: &mut App, code: KeyCode) -> Vec<Request> {
    let (_, page) = transcript_extent(app);
    let delta: isize = match code {
        KeyCode::Char('j') | KeyCode::Down => 1,
        KeyCode::Char('k') | KeyCode::Up => -1,
        KeyCode::PageDown | KeyCode::Char(' ' | 'd') => page as isize,
        KeyCode::PageUp | KeyCode::Char('b' | 'u') => -(page as isize),
        KeyCode::Char('g') | KeyCode::Home => isize::MIN / 2,
        KeyCode::Char('G') | KeyCode::End => isize::MAX / 2,
        _ => 0,
    };
    scroll_transcript(app, delta)
}

pub(crate) fn scroll_transcript(app: &mut App, delta: isize) -> Vec<Request> {
    let (length, page) = transcript_extent(app);
    let Some(view) = app.transcript.as_mut() else {
        return Vec::new();
    };
    let max = length.saturating_sub(page);
    view.scroll = view.scroll.min(max).saturating_add_signed(delta).min(max);
    more_transcript(view, length, page)
}

pub(crate) fn more_transcript(view: &mut Transcript, length: usize, page: usize) -> Vec<Request> {
    if view.loading || view.scroll + page * 2 < length {
        return Vec::new();
    }
    let Some(cursor) = view.next_cursor.clone() else {
        return Vec::new();
    };
    view.loading = true;
    view.requested = true;
    vec![Request::Transcript {
        session_id: view.session.id.clone(),
        cursor: Some(cursor),
    }]
}

/// One frame of easing toward the scroll target. True while still moving.
pub(crate) fn animate(app: &App) -> bool {
    let Some(view) = &app.transcript else {
        return false;
    };
    let target = view.scroll as f32;
    let shown = view.shown.get();
    let distance = target - shown;
    if distance.abs() < 0.5 {
        view.shown.set(target);
        return false;
    }
    view.shown.set(shown + distance * 0.45);
    true
}

/// Jumps the easing to its target, as a test wants to see where it ends.
#[cfg(test)]
pub(crate) fn settle(app: &App) {
    if let Some(view) = &app.transcript {
        view.shown.set(view.scroll as f32);
    }
}

/// How many list rows fit, for page keys.
pub(crate) fn page(app: &App) -> usize {
    (list_height(app) / super::draw::list::ROW_HEIGHT).max(1)
}
