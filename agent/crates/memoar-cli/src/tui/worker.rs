//! Runs a request with the same functions the commands use.
//!
//! `view`, `search`, `status` and `convert` are the command implementations
//! themselves, called with the arguments their flags would have produced. The
//! session list, the machine names and the export have no command of their
//! own, and go through the same `ApiClient` and credential loading.

use serde_json::Value;

use super::cache;
use super::export::export;
use super::model::machine_names;
use super::request::{Request, Response};
use crate::api::ApiClient;
use crate::args::{ConvertArgs, SearchArgs, ViewArgs};
use crate::config::{RuntimePaths, authenticated_config};
use crate::error::AppError;

/// Sessions per page. The archive's ceiling.
const PAGE: u16 = 100;
/// Turns per transcript chunk. The archive's ceiling.
const CHUNK: u16 = 200;
/// How long a conversion may take before the TUI stops waiting for it.
const CONVERT_WAIT_SECONDS: u64 = 120;

/// Blocks until the archive answers. The loop calls it off the drawing thread.
pub(crate) fn run(request: Request, paths: &RuntimePaths) -> Response {
    match request {
        Request::Sessions { cursor } => {
            let result = sessions(paths, cursor.as_deref());
            if cursor.is_none()
                && let Ok(page) = &result
            {
                cache::save_sessions(paths, page);
            }
            Response::Sessions { cursor, result }
        }
        Request::Machines => Response::Machines(client(paths).and_then(|api| {
            let names = machine_names(&api.get("/machines")?);
            cache::save_machines(paths, &names);
            Ok(names)
        })),
        Request::Transcript { session_id, cursor } => {
            let args = ViewArgs {
                session_id: session_id.clone(),
                chunk_size: CHUNK,
                cursor: cursor.clone(),
            };
            let result = crate::query::view(&args, paths).map(|output| output.data);
            Response::Transcript {
                session_id,
                cursor,
                result,
            }
        }
        Request::Search { query, cursor } => {
            let result = search(paths, &query, cursor.as_deref());
            Response::Search {
                query,
                cursor,
                result,
            }
        }
        Request::Status => Response::Status(crate::status::status(paths).map(|output| output.data)),
        Request::Convert { session_id, target } => {
            let args = ConvertArgs {
                session_id: session_id.clone(),
                target: target.clone(),
                fallback: "injection".to_owned(),
                here: true,
                bundle: None,
                wait_seconds: CONVERT_WAIT_SECONDS,
                poll_milliseconds: 500,
            };
            let result = crate::convert::convert(&args, paths).map(|output| output.data);
            Response::Converted {
                session_id,
                target,
                result,
            }
        }
        Request::Export { session_id } => {
            let result = std::env::current_dir()
                .map_err(|error| {
                    AppError::local(
                        format!("could not find the working directory: {error}"),
                        "Start memoar tui from a directory you can write to.",
                    )
                })
                .and_then(|directory| export(paths, &session_id, &directory));
            Response::Exported { session_id, result }
        }
        Request::Copy { text } => {
            let result = super::clipboard::copy(&text);
            Response::Copied { text, result }
        }
    }
}

fn client(paths: &RuntimePaths) -> Result<ApiClient, AppError> {
    let (config, token) = authenticated_config(paths)?;
    Ok(ApiClient::new(&config.endpoint, Some(&token)))
}

/// A page of `GET /sessions`, newest first.
pub(crate) fn sessions(paths: &RuntimePaths, cursor: Option<&str>) -> Result<Value, AppError> {
    let mut query = vec![("limit", PAGE.to_string())];
    if let Some(cursor) = cursor {
        query.push(("cursor", cursor.to_owned()));
    }
    client(paths)?.get_query("/sessions", &query)
}

/// `memoar search`. The command has no cursor flag, so a later page goes
/// through the same client with the cursor the first page returned.
fn search(paths: &RuntimePaths, query: &str, cursor: Option<&str>) -> Result<Value, AppError> {
    let args = SearchArgs {
        query: query.to_owned(),
        mode: "hybrid".to_owned(),
        limit: PAGE,
        agent: None,
        workspace: None,
    };
    let Some(cursor) = cursor else {
        return crate::query::search(&args, paths).map(|output| output.data);
    };
    client(paths)?.get_query(
        "/search",
        &[
            ("q", args.query),
            ("mode", args.mode),
            ("limit", args.limit.to_string()),
            ("cursor", cursor.to_owned()),
        ],
    )
}
