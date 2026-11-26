//! `memoar tui`: the archive in the terminal.
//!
//! The session list with the selected transcript beside it, search, a
//! command palette, and the actions the commands have: convert and resume
//! here, export, copy an id, and the capture status. Everything it shows
//! comes from the same functions the commands call.

mod action;
mod app;
mod cache;
mod clipboard;
mod colour;
mod draw;
mod export;
mod fuzzy;
mod keys;
mod layout;
mod model;
mod mouse;
mod navigate;
mod palette;
mod render;
mod request;
mod run;
mod style;
mod terminal;
mod text;
mod update;
mod worker;

#[cfg(test)]
mod tests;

use std::io::IsTerminal;

use crate::config::{RuntimePaths, authenticated_config};
use crate::error::AppError;
use app::App;
use request::Request;

pub(crate) fn launch(json: bool, paths: &RuntimePaths) -> Result<(), AppError> {
    if json {
        return Err(
            AppError::usage("memoar tui is interactive and has no JSON output").with_hint(
                "Use `memoar search`, `memoar view` and `memoar convert` with --json instead.",
            ),
        );
    }
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Err(AppError::usage("memoar tui needs a terminal to draw in")
            .with_hint("Run it in a terminal window, not through a pipe or a script."));
    }
    // Not signed in is said here, in the shell, where `memoar login` can be
    // typed next, not inside a screen that has to be quit first.
    let (config, _) = authenticated_config(paths)?;
    style::choose_glyphs();
    colour::choose_theme();
    let mut app = App::new(config.endpoint);
    let first = start(&mut app, paths);
    let mut guard = terminal::Guard::enter().map_err(|error| {
        AppError::local(
            format!("could not take over the terminal: {error}"),
            "Run memoar tui in a terminal window.",
        )
    })?;
    let result = run::run(&mut guard, &mut app, paths, first);
    drop(guard);
    result
}

/// What is shown before the archive answers, and the first requests.
pub(crate) fn start(app: &mut App, paths: &RuntimePaths) -> Vec<Request> {
    app.machines = cache::load_machines(paths);
    if let Some((page, saved_at)) = cache::load_sessions(paths) {
        update::apply(
            app,
            request::Response::Sessions {
                cursor: None,
                result: Ok(page),
            },
        );
        app.sessions.cached_at = Some(saved_at);
        app.sessions.loading = true;
    }
    vec![Request::Sessions { cursor: None }, Request::Machines]
}
