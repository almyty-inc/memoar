//! What each key does. Changes the state and returns the requests to run.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::action::{Action, perform, submit_search};
use super::app::{App, Overlay, Screen, SearchFocus, TARGETS};
use super::navigate::{list_target, page, select, transcript_key};
use super::request::Request;

pub(crate) fn handle(app: &mut App, key: KeyEvent) -> Vec<Request> {
    // Windows reports a release, and on some consoles a repeat, as events of
    // their own. Only the press is a key.
    if key.kind != KeyEventKind::Press {
        return Vec::new();
    }
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    if control && key.code == KeyCode::Char('c') {
        app.quit = true;
        return Vec::new();
    }
    match &app.overlay {
        Some(Overlay::Palette { .. }) => return super::palette::key(app, key),
        Some(Overlay::ConvertPicker { .. }) => return picker_key(app, key),
        Some(Overlay::Message { lines, .. }) => {
            // `y` copies the resume command, which is what one does next.
            let command = lines
                .iter()
                .find_map(|line| line.strip_prefix("$ "))
                .filter(|_| key.code == KeyCode::Char('y'))
                .map(str::to_owned);
            app.overlay = None;
            return command
                .map(|text| vec![Request::Copy { text }])
                .unwrap_or_default();
        }
        None => {}
    }
    if control && key.code == KeyCode::Char('p') {
        return perform(app, Action::Palette);
    }
    match app.screen() {
        Screen::Search if app.search.focus == SearchFocus::Input => search_input_key(app, key),
        Screen::Status => status_key(app, key),
        Screen::Transcript => {
            if let Some(action) = action_key(app, key) {
                return perform(app, action);
            }
            match key.code {
                KeyCode::Tab | KeyCode::Char('h') | KeyCode::Left => {
                    app.back();
                    Vec::new()
                }
                code => transcript_key(app, code),
            }
        }
        Screen::Sessions | Screen::Search => {
            if let Some(action) = action_key(app, key) {
                return perform(app, action);
            }
            match key.code {
                KeyCode::Enter | KeyCode::Tab | KeyCode::Char('l') | KeyCode::Right => {
                    perform(app, Action::Open)
                }
                KeyCode::Char('i' | '/') if app.screen() == Screen::Search => {
                    app.search.focus = SearchFocus::Input;
                    Vec::new()
                }
                _ => match list_target(app.list(), key, page(app)) {
                    Some(target) => select(app, target),
                    None => Vec::new(),
                },
            }
        }
    }
}

/// The keys every session screen shares.
fn action_key(app: &App, key: KeyEvent) -> Option<Action> {
    let action = match key.code {
        KeyCode::Esc => Action::Escape,
        KeyCode::Char('q') => Action::Back,
        KeyCode::Char(':') => Action::Palette,
        KeyCode::Char('/') if app.screen() == Screen::Search => {
            return None;
        }
        KeyCode::Char('/') => Action::Search,
        KeyCode::Char('s') => Action::Status,
        KeyCode::Char('c') => Action::ChooseTarget,
        KeyCode::Char('e') => Action::Export,
        KeyCode::Char('y') => Action::CopyId,
        KeyCode::Char('t') => Action::ToggleThinking,
        KeyCode::Char('r') if app.screen() == Screen::Sessions => Action::Refresh,
        _ => return None,
    };
    Some(action)
}

fn search_input_key(app: &mut App, key: KeyEvent) -> Vec<Request> {
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    let search = &mut app.search;
    match key.code {
        KeyCode::Esc => app.escape(),
        KeyCode::Enter => return submit_search(app),
        KeyCode::Down | KeyCode::Tab if !search.results.rows.is_empty() => {
            search.focus = SearchFocus::Results;
        }
        KeyCode::Backspace => {
            search.input.pop();
        }
        KeyCode::Char('u') if control => search.input.clear(),
        KeyCode::Char(character) if !control => search.input.push(character),
        _ => {}
    }
    Vec::new()
}

fn status_key(app: &mut App, key: KeyEvent) -> Vec<Request> {
    match key.code {
        KeyCode::Char('r') => perform(app, Action::Refresh),
        KeyCode::Char(':') => perform(app, Action::Palette),
        KeyCode::Esc => perform(app, Action::Escape),
        KeyCode::Char('q' | 's') => perform(app, Action::Back),
        _ => Vec::new(),
    }
}

fn picker_key(app: &mut App, key: KeyEvent) -> Vec<Request> {
    let Some(Overlay::ConvertPicker { selected, .. }) = &mut app.overlay else {
        return Vec::new();
    };
    let chosen = match key.code {
        KeyCode::Esc | KeyCode::Char('q') => {
            app.overlay = None;
            return Vec::new();
        }
        KeyCode::Char('j') | KeyCode::Down => {
            *selected = (*selected + 1).min(TARGETS.len() - 1);
            return Vec::new();
        }
        KeyCode::Char('k') | KeyCode::Up => {
            *selected = selected.saturating_sub(1);
            return Vec::new();
        }
        KeyCode::Char(digit @ '1'..='3') => usize::from(digit as u8 - b'1'),
        KeyCode::Enter => *selected,
        _ => return Vec::new(),
    };
    app.overlay = None;
    perform(app, Action::Convert(TARGETS[chosen].0))
}
