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
    let idle_deadline = (args.idle_timeout_seconds > 0)
        .then(|| Instant::now() + Duration::from_secs(args.idle_timeout_seconds));

    loop {
        if let Some(deadline) = idle_deadline {
            if Instant::now() >= deadline {
                break;
            }
        }
        let read = stream
            .read(&mut chunk)
            .map_err(|error| AppError::network(format!("command stream ended: {error}")))?;
        if read == 0 {
            break;
        }
        let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
        for event in decoder.push(&text) {
            if event.event != "command" {
                continue;
            }
            let command: Value = serde_json::from_str(&event.data)
                .map_err(|error| AppError::network(format!("invalid command payload: {error}")))?;
            handled.push(apply_command(&machine_api, &config, paths, &command)?);
            if args.max_commands > 0 && handled.len() >= args.max_commands {
                return Ok(CommandOutput {
                    command: "listen".to_owned(),
                    data: json!({ "handled": handled }),
                });
            }
        }
    }
    Ok(CommandOutput {
        command: "listen".to_owned(),
        data: json!({ "handled": handled }),
    })
}

/// Applies one server command and acknowledges its outcome.
fn apply_command(
    machine_api: &ApiClient,
    config: &Config,
    paths: &RuntimePaths,
    command: &Value,
) -> Result<Value, AppError> {
    let command_id = command
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::network("command did not include an id"))?;
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
    machine_api.post(
        &format!("/machines/{}/commands/{command_id}/ack", config.machine_id),
        &ack,
    )?;

    let result = outcome?;
    Ok(json!({ "id": command_id, "kind": kind, "result": result }))
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
