//! What an answer from the archive changes.

use serde_json::Value;

use super::app::{App, Overlay, Screen, SessionList, TARGETS, Transcript, is_offline};
use super::model::{SessionRow, next_cursor, plural, rows};
use super::navigate::{follow, more_transcript, transcript_extent};
use super::request::{Request, Response};
use crate::error::AppError;

/// Applies one answer. Returns follow-up requests, such as the next chunk of
/// a transcript that does not yet fill the screen.
pub(crate) fn apply(app: &mut App, response: Response) -> Vec<Request> {
    match response {
        Response::Sessions { cursor, result } => {
            app.sessions.loading = false;
            match result {
                Ok(page) => {
                    app.offline = false;
                    merge_page(&mut app.sessions, cursor.is_none(), &page);
                    app.sessions.cached_at = None;
                    if app.list_screen() == Screen::Sessions && app.screen() != Screen::Transcript {
                        follow(app);
                    }
                }
                Err(error) => app.fail(&error),
            }
        }
        Response::Machines(result) => {
            // Names are a nicety. Without them the column is empty.
            if let Ok(machines) = result {
                app.machines = machines;
            }
        }
        Response::Transcript {
            session_id,
            cursor,
            result,
        } => return transcript(app, &session_id, cursor.is_none(), result),
        Response::Search {
            query,
            cursor,
            result,
        } => {
            if app.search.query.as_deref() != Some(query.as_str()) {
                return Vec::new();
            }
            app.search.results.loading = false;
            match result {
                Ok(page) => {
                    app.offline = false;
                    let search = &mut app.search;
                    merge_page(&mut search.results, cursor.is_none(), &page);
                    search.realized_mode = page
                        .pointer("/meta/realizedMode")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    search.error = None;
                    if app.screen() == Screen::Search {
                        follow(app);
                    }
                }
                Err(error) => {
                    app.search.error = Some(error.message.clone());
                    app.fail(&error);
                }
            }
        }
        Response::Status(result) => {
            app.status.loading = false;
            match result {
                Ok(data) => {
                    app.status.data = Some(data);
                    app.status.error = None;
                }
                Err(error) => {
                    app.status.error = Some(format!("{} {}", error.message, error.hint));
                }
            }
        }
        Response::Converted {
            session_id,
            target,
            result,
        } => {
            app.converting.retain(|id| id != &session_id);
            app.notice = None;
            let label = TARGETS
                .iter()
                .find(|(id, _)| *id == target)
                .map_or(target.as_str(), |(_, label)| label);
            app.overlay = Some(match result {
                Ok(data) => converted(label, &data),
                Err(error) => Overlay::Message {
                    title: format!("Not converted for {label}"),
                    lines: vec![error.message, error.hint],
                },
            });
        }
        Response::Exported { session_id, result } => match result {
            // The file name first: a long working directory would push it
            // off the end of the line.
            Ok(path) => app.info(format!(
                "Exported {} to {}",
                path.file_name().map_or(session_id.clone(), |name| name
                    .to_string_lossy()
                    .into_owned()),
                path.parent()
                    .map(|parent| parent.display().to_string())
                    .unwrap_or_default()
            )),
            Err(error) => app.fail(&error),
        },
        Response::Copied { text, result } => match result {
            Ok(how) => app.info(format!("Copied {text} {how}")),
            Err(reason) => app.fail(&AppError::local(
                format!("Could not copy the id ({reason}). It is {text}"),
                "",
            )),
        },
    }
    Vec::new()
}

fn merge_page(list: &mut SessionList, first: bool, page: &Value) {
    let fresh: Vec<SessionRow> = rows(page);
    if first {
        // Keep the reader on the session they had selected, if it is still there.
        let selected = list.current().map(|row| row.id.clone());
        list.rows = fresh;
        list.selected = selected
            .and_then(|id| list.rows.iter().position(|row| row.id == id))
            .unwrap_or(0);
    } else {
        let known: std::collections::HashSet<String> =
            list.rows.iter().map(|row| row.id.clone()).collect();
        list.rows
            .extend(fresh.into_iter().filter(|row| !known.contains(&row.id)));
    }
    list.next_cursor = next_cursor(page);
    list.total = page.get("total").and_then(Value::as_u64);
}

/// A chunk lands in the transcript on screen, or in memory when the reader
/// has already moved on, so going back to it is instant.
fn transcript(
    app: &mut App,
    session_id: &str,
    first: bool,
    result: Result<Value, AppError>,
) -> Vec<Request> {
    let on_screen = app
        .transcript
        .as_ref()
        .is_some_and(|view| view.session.id == session_id);
    let view = if on_screen {
        app.transcript.as_mut()
    } else {
        app.viewed.get_mut(session_id)
    };
    let Some(view) = view else {
        return Vec::new();
    };
    view.loading = false;
    match result {
        Ok(chunk) => {
            app.offline = false;
            fill(view, first, &chunk);
        }
        Err(error) => {
            view.requested = false;
            view.error = Some(if is_offline(&error) {
                "The archive cannot be reached and this transcript was not read earlier in this run. Select it again to retry.".to_owned()
            } else {
                error.message.clone()
            });
            if on_screen {
                app.fail(&error);
            }
            return Vec::new();
        }
    }
    if !on_screen {
        return Vec::new();
    }
    let (length, page) = transcript_extent(app);
    app.transcript
        .as_mut()
        .map(|view| more_transcript(view, length, page))
        .unwrap_or_default()
}

fn fill(view: &mut Transcript, first: bool, chunk: &Value) {
    let turns = chunk
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if first {
        view.turns = turns;
    } else {
        view.turns.extend(turns);
    }
    if let Some(session) = chunk.get("session").and_then(SessionRow::from_value) {
        view.session = session;
    }
    view.next_cursor = next_cursor(chunk);
    view.error = None;
}

fn converted(label: &str, data: &Value) -> Overlay {
    let count = |name: &str| data.get(name).and_then(Value::as_array).map_or(0, Vec::len) as u64;
    let mut lines = vec![format!(
        "{} written, {} already there and left as they were.",
        plural(count("written"), "file", "files"),
        count("unchanged")
    )];
    if let Some(command) = data.get("resumeCommand").and_then(Value::as_str) {
        lines.push(String::new());
        lines.push("Resume it with".to_owned());
        lines.push(format!("$ {command}"));
    }
    Overlay::Message {
        title: format!("Converted for {label}"),
        lines,
    }
}
