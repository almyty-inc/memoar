//! `memoar mcp`: the archive's MCP tools over stdio.
//!
//! An agent that launches local servers, or that cannot send a custom header,
//! points at this command and needs nothing else: the credential is the one
//! `memoar login` stored. Messages are newline-delimited JSON-RPC, as the MCP
//! stdio transport defines them. Standard output carries protocol and nothing
//! else, so every diagnostic goes to standard error.

use serde_json::{Value, json};
use std::io::{BufRead, Write};

use super::proxy::McpProxy;
use crate::config::RuntimePaths;
use crate::error::AppError;

/// JSON-RPC's code for a message that is not JSON.
const PARSE_ERROR: i64 = -32700;
/// The range JSON-RPC leaves to the implementation. Used for an archive that
/// could not be reached or refused the request.
const SERVER_ERROR: i64 = -32000;

pub(crate) fn serve(paths: &RuntimePaths) -> Result<(), AppError> {
    let mut proxy = McpProxy::from_paths(paths)?;
    eprintln!("memoar mcp: serving {} over stdio", proxy.url());
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    serve_streams(&mut proxy, stdin.lock(), stdout.lock())
}

/// The loop itself, over any pair of streams, so a test can drive it.
pub(crate) fn serve_streams(
    proxy: &mut McpProxy,
    input: impl BufRead,
    mut output: impl Write,
) -> Result<(), AppError> {
    let broken = |error: std::io::Error| AppError::internal(format!("stdio failed: {error}"));
    for line in input.lines() {
        let line = line.map_err(broken)?;
        if line.trim().is_empty() {
            continue;
        }
        for reply in handle_line(proxy, &line) {
            writeln!(output, "{reply}").map_err(broken)?;
        }
        output.flush().map_err(broken)?;
    }
    Ok(())
}

/// The replies one line from the client earns.
pub(crate) fn handle_line(proxy: &mut McpProxy, line: &str) -> Vec<Value> {
    let message: Value = match serde_json::from_str(line) {
        Ok(message) => message,
        Err(error) => {
            return vec![error_reply(
                &Value::Null,
                PARSE_ERROR,
                &format!("not JSON: {error}"),
            )];
        }
    };
    match proxy.forward(&message) {
        Ok(replies) => replies,
        Err(error) => {
            eprintln!("memoar mcp: {}\nhint: {}", error.message, error.hint);
            let text = format!("{} {}", error.message, error.hint);
            request_ids(&message)
                .iter()
                .map(|id| error_reply(id, SERVER_ERROR, &text))
                .collect()
        }
    }
}

/// The ids of the requests in a message or batch. Notifications have none,
/// and are owed no answer even when forwarding them failed.
fn request_ids(message: &Value) -> Vec<Value> {
    let single = |item: &Value| {
        item.get("method")
            .and(item.get("id"))
            .filter(|id| !id.is_null())
            .cloned()
    };
    match message {
        Value::Array(items) => items.iter().filter_map(single).collect(),
        other => single(other).into_iter().collect(),
    }
}

fn error_reply(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}
