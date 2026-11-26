//! The loop: draw, read input, run requests off the drawing thread, apply
//! what comes back.

use ratatui::crossterm::event::{self, Event};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use super::app::App;
use super::navigate::{animate, fetch_preview};
use super::request::{Request, Response};
use super::terminal::Guard;
use super::{draw, keys, mouse, update, worker};
use crate::config::RuntimePaths;
use crate::error::AppError;

/// How long the selection must rest before its preview is fetched.
const PREVIEW_DELAY: Duration = Duration::from_millis(90);
/// A frame while something moves, and the wait for input while nothing does.
const FRAME: Duration = Duration::from_millis(16);
const IDLE: Duration = Duration::from_millis(250);

pub(crate) fn run(
    guard: &mut Guard,
    app: &mut App,
    paths: &RuntimePaths,
    first: Vec<Request>,
) -> Result<(), AppError> {
    let (sender, receiver) = mpsc::channel();
    dispatch(first, &sender, paths);
    let mut pending_since: Option<Instant> = None;
    // The grammars take a moment to load. Load them before the first code block.
    thread::spawn(super::render::code::warm);
    loop {
        let size = guard.terminal.size().map_err(terminal_error)?;
        app.width = size.width;
        app.height = size.height;
        let moving = animate(app);
        guard
            .terminal
            .draw(|frame| draw::draw(frame, app))
            .map_err(terminal_error)?;
        let mut requests = drain(app, &receiver);
        let wait = if moving || app.preview_pending {
            FRAME
        } else {
            IDLE
        };
        if event::poll(wait).map_err(terminal_error)? {
            // Everything already queued, so a held key does not lag behind.
            loop {
                requests.extend(input(app, event::read().map_err(terminal_error)?));
                if !event::poll(Duration::ZERO).map_err(terminal_error)? {
                    break;
                }
            }
        }
        if app.preview_pending {
            let since = *pending_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= PREVIEW_DELAY {
                requests.extend(fetch_preview(app));
                pending_since = None;
            }
        } else {
            pending_since = None;
        }
        dispatch(requests, &sender, paths);
        if app.quit {
            return Ok(());
        }
    }
}

fn input(app: &mut App, event: Event) -> Vec<Request> {
    match event {
        Event::Key(key) => keys::handle(app, key),
        Event::Mouse(mouse_event) => mouse::handle(app, mouse_event),
        // The next frame is drawn at the new size.
        _ => Vec::new(),
    }
}

fn drain(app: &mut App, receiver: &Receiver<Response>) -> Vec<Request> {
    let mut requests = Vec::new();
    while let Ok(response) = receiver.try_recv() {
        requests.extend(update::apply(app, response));
    }
    requests
}

/// Each request on a thread of its own, except the clipboard, which may
/// write to the terminal and so stays on this one.
fn dispatch(requests: Vec<Request>, sender: &Sender<Response>, paths: &RuntimePaths) {
    for request in requests {
        if let Request::Copy { .. } = request {
            let _ = sender.send(worker::run(request, paths));
            continue;
        }
        let sender = sender.clone();
        let paths = paths.clone();
        thread::spawn(move || {
            let fallback = failed(&request);
            let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                worker::run(request, &paths)
            }))
            .unwrap_or(fallback);
            let _ = sender.send(response);
        });
    }
}

/// What a request reports when its thread panicked.
fn failed(request: &Request) -> Response {
    let error = || Err(AppError::internal("the request stopped unexpectedly"));
    match request.clone() {
        Request::Sessions { cursor } => Response::Sessions {
            cursor,
            result: error(),
        },
        Request::Machines => Response::Machines(Err(AppError::internal("machines"))),
        Request::Transcript { session_id, cursor } => Response::Transcript {
            session_id,
            cursor,
            result: error(),
        },
        Request::Search { query, cursor } => Response::Search {
            query,
            cursor,
            result: error(),
        },
        Request::Status => Response::Status(error()),
        Request::Convert { session_id, target } => Response::Converted {
            session_id,
            target,
            result: error(),
        },
        Request::Export { session_id } => Response::Exported {
            session_id,
            result: Err(AppError::internal("the export stopped unexpectedly")),
        },
        Request::Copy { text } => Response::Copied {
            text,
            result: Err("stopped unexpectedly".to_owned()),
        },
    }
}

fn terminal_error(error: std::io::Error) -> AppError {
    AppError::local(
        format!("the terminal stopped answering: {error}"),
        "Run memoar tui again in a terminal window.",
    )
}
