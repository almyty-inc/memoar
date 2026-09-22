use memoar_materializer::{ConversionBundle, materialize_bundle};
use serde_json::{Value, json};
use std::io::Read as _;
use std::time::{Duration, Instant};

use crate::CommandOutput;
use crate::api::ApiClient;
use crate::args::ListenArgs;
use crate::config::{Config, RuntimePaths, authenticated_config};
use crate::credential::Credential;
use crate::error::{AppError, map_materialize_error};
use crate::machine::issue_machine_token;
use crate::sse::SseDecoder;

/// Subscribes to this machine's durable command channel and materializes
/// conversion bundles as the server pushes them.
///
/// Commands are acknowledged only after materialization succeeds, so a crash
/// mid-materialize leaves the command unacked and the server replays it on the
/// next connection. Failures are acked with their reason so an operator can see
/// why a machine could not apply a bundle.
pub(crate) fn listen(args: &ListenArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let (config, token) = authenticated_config(paths)?;
    let api = ApiClient::new(&config.endpoint, Some(&token));
    let (machine_token, _) = issue_machine_token(&api, &config.machine_id)?;
    let machine_api = ApiClient::new(
        &config.endpoint,
        Some(&Credential::Bearer(machine_token.clone())),
    );

    let response = machine_api
        .authorize(
            machine_api
                .client
                .get(machine_api.url(&format!("/machines/{}/commands/stream", config.machine_id))),
        )
        .header("accept", "text/event-stream")
        .send()
        .map_err(|error| AppError::network(format!("command stream failed: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::network(format!(
            "command stream rejected with status {}",
            response.status()
        )));
    }

    let mut stream = response;
    let mut decoder = SseDecoder::new();
    let mut handled: Vec<Value> = Vec::new();
    let mut chunk = [0_u8; 8192];
    // The window is idle time, not total time. It was computed once before the
    // loop and never moved, so a machine that kept receiving commands was still
    // killed at the deadline set when it connected — the opposite of what the
    // flag says, and worst for the machine doing the most work. Every handled
    // command pushes it out.
    let idle_window =
        (args.idle_timeout_seconds > 0).then(|| Duration::from_secs(args.idle_timeout_seconds));
    let mut idle_deadline = idle_window.map(|window| Instant::now() + window);

    // Why the loop ended, so the report says it rather than leaving the reader
    // to infer it from a count. A transport failure is still a failure — see
    // the exit below — but the commands already applied are reported either
    // way: they were acked, they wrote files, and a listener that says nothing
    // about them leaves the operator with no local record of what changed.
    let stopped;
    loop {
        if let Some(deadline) = idle_deadline {
            if Instant::now() >= deadline {
                stopped = Stop::idle(args.idle_timeout_seconds);
                break;
            }
        }
        let read = match stream.read(&mut chunk) {
            Ok(read) => read,
            Err(error) => {
                stopped = Stop::failed(format!("command stream ended: {error}"));
                break;
            }
        };
        if read == 0 {
            stopped = Stop::ok("the archive closed the command stream");
            break;
        }
        let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
        for event in decoder.push(&text) {
            if event.event != "command" {
                continue;
            }
            // A frame this client cannot parse is a fact about that frame. It
            // was propagated, which ended the listener: one malformed payload
            // from the archive and the machine went deaf to every command
            // after it — the same defect already fixed one layer down, left
            // standing here.
            let command: Value = match serde_json::from_str(&event.data) {
                Ok(command) => command,
                Err(error) => {
                    handled.push(json!({
                        "status": "failed",
                        "error": format!("command payload was not JSON: {error}"),
                    }));
                    continue;
                }
            };
            handled.push(apply_command(&machine_api, &config, paths, &command));
            idle_deadline = idle_window.map(|window| Instant::now() + window);
            if args.max_commands > 0 && handled.len() >= args.max_commands {
                return Ok(listened(handled, Stop::ok("--max-commands reached")));
            }
        }
    }
    if let Some(failure) = stopped.failure {
        // Non-zero, because a listener that stopped listening has failed even
        // if it did useful work first, and a wrapper that restarts it depends
        // on hearing so. The record of the work goes with the error.
        return Err(AppError::network(format!(
            "{failure} (applied {} command(s) before it did)",
            handled.len()
        )));
    }
    Ok(listened(handled, stopped))
}

/// Why the listener stopped.
struct Stop {
    reason: String,
    /// Set when stopping was itself the failure, rather than the window
    /// closing or the archive hanging up politely.
    failure: Option<String>,
}

impl Stop {
    fn ok(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            failure: None,
        }
    }

    fn idle(seconds: u64) -> Self {
        Self::ok(format!("no command arrived for {seconds}s"))
    }

    fn failed(reason: impl Into<String>) -> Self {
        let reason = reason.into();
        Self {
            failure: Some(reason.clone()),
            reason,
        }
    }
}

fn listened(handled: Vec<Value>, stopped: Stop) -> CommandOutput {
    CommandOutput {
        command: "listen".to_owned(),
        data: json!({
            "handled": handled,
            // Counted, not derived from the length of anything else: a
            // listener is judged on how many commands it actually applied.
            "applied": handled
                .iter()
                .filter(|entry| entry.get("status") != Some(&json!("failed")))
                .count(),
            "failed": handled
                .iter()
                .filter(|entry| entry.get("status") == Some(&json!("failed")))
                .count(),
            "stoppedBecause": stopped.reason,
        }),
    }
}

/// Applies one server command and acknowledges its outcome.
///
/// Never fails: every outcome, including one this client could not even read,
/// comes back as an entry in the report. Nothing about one command is a reason
/// to stop applying the next.
fn apply_command(
    machine_api: &ApiClient,
    config: &Config,
    paths: &RuntimePaths,
    command: &Value,
) -> Value {
    // An id-less command cannot be acked — there is no acknowledgement URL to
    // ack it at — but it is still only one command. Propagating it closed the
    // channel, so a single malformed row in the archive's command table made a
    // machine deaf to everything queued behind it.
    let Some(command_id) = command.get("id").and_then(Value::as_str) else {
        return json!({
            "status": "failed",
            "error": "command did not include an id, so it could not be acknowledged",
            "kind": command.get("kind").and_then(Value::as_str).unwrap_or_default(),
        });
    };
    let kind = command
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = command.get("payload").cloned().unwrap_or(Value::Null);

    let outcome = match kind {
        "materialize" => materialize_from_command(paths, &payload),
        other => Err(AppError::usage(format!(
            "unsupported command kind: {other}"
        ))),
    };

    let ack = match &outcome {
        Ok(_) => json!({ "status": "completed" }),
        Err(error) => json!({ "status": "failed", "error": error.message.clone() }),
    };
    // A refused ack is reported, not fatal. The work is already done on this
    // machine; the server will replay the command, and materialization is
    // no-clobber, so a replay is cheap. Ending the listener over it is not.
    let acked = machine_api.post(
        &format!("/machines/{}/commands/{command_id}/ack", config.machine_id),
        &ack,
    );

    // A command this machine cannot apply is a fact about that command, not a
    // reason to stop listening. It was acked as failed — which is what tells an
    // operator why — and then returned as an error, which ended the listener.
    // One unsupported kind, or one bundle that would not materialize, and the
    // machine went deaf to every command after it.
    let mut entry = match outcome {
        Ok(result) => json!({ "id": command_id, "kind": kind, "result": result }),
        Err(error) => json!({
            "id": command_id,
            "kind": kind,
            "status": "failed",
            "error": error.message,
        }),
    };
    if let Err(error) = acked {
        entry["acknowledged"] = json!(false);
        entry["acknowledgementError"] = json!(error.message);
    }
    entry
}

/// Downloads the pre-signed bundle named by a materialize command and writes it
/// into the local native store.
fn materialize_from_command(paths: &RuntimePaths, payload: &Value) -> Result<Value, AppError> {
    let url = payload
        .get("downloadUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::network("materialize command did not include downloadUrl"))?;
    let anonymous = ApiClient::new("", None);
    let bytes = anonymous.send_bytes(anonymous.client.get(url))?;
    let bundle: ConversionBundle = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::network(format!("invalid conversion bundle: {error}")))?;
    if let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) {
        if bundle.session_id != session_id {
            return Err(AppError::network(
                "downloaded bundle session id did not match the command",
            ));
        }
    }
    let result = materialize_bundle(&bundle, &paths.home).map_err(map_materialize_error)?;
    serde_json::to_value(result).map_err(|error| AppError::internal(error.to_string()))
}
