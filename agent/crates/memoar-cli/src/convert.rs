use memoar_materializer::{ConversionBundle, Target, materialize_bundle};
use serde_json::{Value, json};
use std::fs;
use std::str::FromStr;
use std::thread;
use std::time::{Duration, Instant};

use crate::CommandOutput;
use crate::api::ApiClient;
use crate::args::ConvertArgs;
use crate::config::{RuntimePaths, authenticated_config};
use crate::error::{AppError, map_materialize_error};

pub(crate) fn convert(args: &ConvertArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    if !matches!(args.fallback.as_str(), "fail" | "injection") {
        return Err(AppError::usage("--fallback must be fail or injection"));
    }
    let native_target = Target::from_str(&args.target);
    if args.here && native_target.is_err() {
        return Err(AppError::usage(
            "--here requires target claude-code, codex, or antigravity-cli",
        ));
    }
    if args.fallback == "fail" && native_target.is_err() {
        return Err(AppError::usage(
            "unknown native target requires --fallback injection",
        ));
    }
    if let Some(bundle_path) = &args.bundle {
        let target = native_target.map_err(|error| AppError::usage(error.to_string()))?;
        let bundle_bytes = fs::read(bundle_path).map_err(|error| {
            AppError::internal(format!("could not read {}: {error}", bundle_path.display()))
        })?;
        let bundle: ConversionBundle = serde_json::from_slice(&bundle_bytes)
            .map_err(|error| AppError::internal(format!("invalid conversion bundle: {error}")))?;
        if bundle.target != target || bundle.session_id != args.session_id {
            return Err(AppError::usage(
                "bundle target or session id does not match the command",
            ));
        }
        return materialize_conversion(bundle, paths);
    }
    let (config, token) = authenticated_config(paths)?;
    let api = ApiClient::new(&config.endpoint, Some(&token));
    let mut job = api.post(
        "/convert",
        &json!({
            "sessionId": args.session_id,
            "target": args.target,
            "fallback": args.fallback
        }),
    )?;
    if !args.here {
        return Ok(CommandOutput {
            command: "convert".to_owned(),
            data: job,
        });
    }
    let job_id = job
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::network("conversion response did not include id"))?
        .to_owned();
    let deadline = Instant::now() + Duration::from_secs(args.wait_seconds.max(1));
    loop {
        match job.get("status").and_then(Value::as_str) {
            Some("ready") => break,
            Some("failed") => {
                return Err(AppError::network(format!(
                    "conversion failed: {}",
                    job.get("report").cloned().unwrap_or(Value::Null)
                )));
            }
            _ if Instant::now() >= deadline => {
                return Err(AppError::network(
                    "conversion did not become ready before timeout",
                ));
            }
            _ => {
                thread::sleep(Duration::from_millis(args.poll_milliseconds.max(25)));
                job = api.get(&format!("/convert/{job_id}"))?;
            }
        }
    }
    let bundle = api.download_conversion(&format!("/convert/{job_id}/download"))?;
    if bundle.session_id != args.session_id || bundle.target != native_target.unwrap() {
        return Err(AppError::network(
            "downloaded bundle target or session id did not match the job",
        ));
    }
    materialize_conversion(bundle, paths)
}

fn materialize_conversion(
    bundle: ConversionBundle,
    paths: &RuntimePaths,
) -> Result<CommandOutput, AppError> {
    let result = materialize_bundle(&bundle, &paths.home).map_err(map_materialize_error)?;
    Ok(CommandOutput {
        command: "convert".to_owned(),
        data: serde_json::to_value(result)
            .map_err(|error| AppError::internal(error.to_string()))?,
    })
}
