//! Forwards MCP JSON-RPC messages to the archive's Streamable HTTP endpoint.
//!
//! The archive serves its tools at `/mcp`, outside the `/v1` prefix, and
//! answers every POST on its own: no session is kept between requests. So a
//! proxy needs no knowledge of the protocol beyond its framing. Each message
//! read from the local client is sent as one POST, and whatever the archive
//! answers, a JSON body or an event stream, goes back as messages.

use reqwest::blocking::Response;
use serde_json::{Value, json};

use crate::api::ApiClient;
use crate::config::{RuntimePaths, authenticated_config};
use crate::error::{AppError, EXIT_REFUSED};
use crate::http_error::http_error;
use crate::sse::SseDecoder;

/// The header a Streamable HTTP client repeats after `initialize`.
const PROTOCOL_HEADER: &str = "mcp-protocol-version";
/// The header a stateful server hands out. The archive is stateless and sends
/// none today, but a client that drops it would break the day it does.
const SESSION_HEADER: &str = "mcp-session-id";

pub(crate) struct McpProxy {
    api: ApiClient,
    url: String,
    protocol_version: Option<String>,
    session_id: Option<String>,
}

/// The MCP endpoint for an API endpoint such as `https://host/v1`.
pub(crate) fn mcp_url(endpoint: &str) -> String {
    let base = endpoint.trim_end_matches('/');
    let origin = base.strip_suffix("/v1").unwrap_or(base);
    format!("{origin}/mcp")
}

impl McpProxy {
    /// A proxy signed in with this computer's stored credential.
    pub(crate) fn from_paths(paths: &RuntimePaths) -> Result<Self, AppError> {
        let (config, credential) = authenticated_config(paths)?;
        Ok(Self::new(
            ApiClient::new(&config.endpoint, Some(&credential)),
            mcp_url(&config.endpoint),
        ))
    }

    pub(crate) fn new(api: ApiClient, url: String) -> Self {
        Self {
            api,
            url,
            protocol_version: None,
            session_id: None,
        }
    }

    pub(crate) fn url(&self) -> &str {
        &self.url
    }

    /// Sends one message, or one batch, and returns every message the archive
    /// answered with. A notification is answered with none.
    pub(crate) fn forward(&mut self, message: &Value) -> Result<Vec<Value>, AppError> {
        let mut request = self
            .api
            .authorize(self.api.client.post(&self.url))
            .header("accept", "application/json, text/event-stream")
            .json(message);
        if let Some(version) = &self.protocol_version {
            request = request.header(PROTOCOL_HEADER, version);
        }
        if let Some(session) = &self.session_id {
            request = request.header(SESSION_HEADER, session);
        }
        let response = request
            .send()
            .map_err(|error| AppError::network(format!("could not reach {}: {error}", self.url)))?;
        let status = response.status().as_u16();
        if let Some(session) = header(&response, SESSION_HEADER) {
            self.session_id = Some(session);
        }
        if !response.status().is_success() {
            let body = response.text().unwrap_or_default();
            return Err(refusal(status, &body));
        }
        if status == 202 || status == 204 {
            return Ok(Vec::new());
        }
        let replies = read_replies(response)?;
        self.remember_protocol(&replies);
        Ok(replies)
    }

    /// Sends one request and returns its `result`, for the CLI's own calls.
    pub(crate) fn request(&mut self, method: &str, params: Value) -> Result<Value, AppError> {
        let replies = self.forward(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }))?;
        let reply = replies
            .into_iter()
            .find(|reply| reply.get("id") == Some(&json!(1)))
            .ok_or_else(|| AppError::network("the archive's MCP endpoint did not answer"))?;
        if let Some(error) = reply.get("error") {
            let message = error["message"].as_str().unwrap_or("MCP request failed");
            return Err(AppError::refused(
                "MEMOAR_MCP_ERROR",
                message,
                "Check the method and its parameters against memoar mcp tools.",
            ));
        }
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    }

    fn remember_protocol(&mut self, replies: &[Value]) {
        let negotiated = replies
            .iter()
            .find_map(|reply| reply.pointer("/result/protocolVersion")?.as_str());
        if let Some(version) = negotiated {
            self.protocol_version = Some(version.to_owned());
        }
    }
}

fn header(response: &Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn read_replies(response: Response) -> Result<Vec<Value>, AppError> {
    let streamed =
        header(&response, "content-type").is_some_and(|kind| kind.starts_with("text/event-stream"));
    let text = response
        .text()
        .map_err(|error| AppError::network(format!("could not read the MCP answer: {error}")))?;
    let invalid =
        |error: serde_json::Error| AppError::network(format!("invalid MCP answer: {error}"));
    if !streamed {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        return Ok(flatten(serde_json::from_str(&text).map_err(invalid)?));
    }
    let mut decoder = SseDecoder::new();
    let mut events = decoder.push(&text);
    events.extend(decoder.push("\n\n"));
    let mut replies = Vec::new();
    for event in events.into_iter().filter(|event| event.event == "message") {
        replies.extend(flatten(serde_json::from_str(&event.data).map_err(invalid)?));
    }
    Ok(replies)
}

fn flatten(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        other => vec![other],
    }
}

/// A refused POST, with the one refusal worth explaining spelled out.
///
/// A key minted by `login` before `memoar mcp` existed holds no `mcp:use`,
/// and the archive refuses it at the door with a 403 naming that scope.
fn refusal(status: u16, body: &str) -> AppError {
    let mut error = http_error(status, body);
    if status == 403 && body.contains("mcp:use") {
        error.exit_code = EXIT_REFUSED;
        error.code = "MEMOAR_MCP_SCOPE".to_owned();
        error.message = "This computer's API key does not hold mcp:use, so the archive refuses its MCP endpoint.".to_owned();
        error.hint = "Run memoar login again. A key minted by a memoar that has the mcp command carries mcp:use.".to_owned();
    }
    error
}
