//! Everything the TUI can do, by name. Keys and the command palette both
//! end up here, so the two can never disagree about what an action does.

use super::app::{App, Overlay, Screen, SearchFocus, TARGETS};
use super::navigate::{self, open_status};
use super::request::Request;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Action {
    Open,
    Search,
    /// Search the archive for this text, from the palette.
    SearchFor(String),
    Status,
    /// Offer the targets for the focused session.
    ChooseTarget,
    /// Convert the focused session for this target and write it here.
    Convert(&'static str),
    Export,
    CopyId,
    ToggleThinking,
    Refresh,
    Palette,
    /// Select this session in the session list.
    Jump(String),
    Back,
    Quit,
}

pub(crate) fn perform(app: &mut App, action: Action) -> Vec<Request> {
    match action {
        Action::Open => navigate::open(app),
        Action::Search => {
            app.push(Screen::Search);
            app.search.focus = SearchFocus::Input;
            Vec::new()
        }
        Action::SearchFor(query) => {
            app.push(Screen::Search);
            app.search.input = query;
            submit_search(app)
        }
        Action::Status => open_status(app),
        Action::ChooseTarget => {
            if let Some(row) = app.focused_session() {
                app.overlay = Some(Overlay::ConvertPicker {
                    session_id: row.id.clone(),
                    title: row.title.clone(),
                    selected: 0,
                });
            }
            Vec::new()
        }
        Action::Convert(target) => {
            let Some(row) = app.focused_session() else {
                return Vec::new();
            };
            let session_id = row.id.clone();
            let label = TARGETS
                .iter()
                .find(|(id, _)| *id == target)
                .map_or(target, |(_, label)| label);
            app.info(format!("Converting \"{}\" for {label}", row.title));
            app.converting.push(session_id.clone());
            vec![Request::Convert {
                session_id,
                target: target.to_owned(),
            }]
        }
        Action::Export => {
            let Some(session_id) = app.focused_session().map(|row| row.id.clone()) else {
                return Vec::new();
            };
            app.info(format!("Exporting {session_id}"));
            vec![Request::Export { session_id }]
        }
        Action::CopyId => app
            .focused_session()
            .map(|row| Request::Copy {
                text: row.id.clone(),
            })
            .into_iter()
            .collect(),
        Action::ToggleThinking => {
            app.show_thinking = !app.show_thinking;
            navigate::scroll_transcript(app, 0)
        }
        Action::Refresh => match app.screen() {
            Screen::Status => open_status(app),
            _ => {
                app.sessions.loading = true;
                vec![Request::Sessions { cursor: None }, Request::Machines]
            }
        },
        Action::Palette => {
            app.overlay = Some(Overlay::Palette {
                input: String::new(),
                selected: 0,
            });
            Vec::new()
        }
        Action::Jump(session_id) => {
            app.stack.truncate(1);
            match app
                .sessions
                .rows
                .iter()
                .position(|row| row.id == session_id)
            {
                Some(index) => navigate::select(app, index),
                None => Vec::new(),
            }
        }
        Action::Back => {
            app.back();
            Vec::new()
        }
        Action::Quit => {
            app.quit = true;
            Vec::new()
        }
    }
}

/// Runs the typed query, and gives the keys to its results.
pub(crate) fn submit_search(app: &mut App) -> Vec<Request> {
    let query = app.search.input.trim().to_owned();
    if query.is_empty() {
        return Vec::new();
    }
    let search = &mut app.search;
    search.focus = SearchFocus::Results;
    search.query = Some(query.clone());
    search.results.loading = true;
    search.results.offset.set(0);
    search.error = None;
    vec![Request::Search {
        query,
        cursor: None,
    }]
}
