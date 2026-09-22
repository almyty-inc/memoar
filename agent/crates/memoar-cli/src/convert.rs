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
        // A path the person typed that is not there, or a file that is not a
        // bundle, is theirs to correct. It used to surface as MEMOAR_UNKNOWN
        // with "run memoar doctor", which inspects the install and knows
        // nothing about a file named on the command line.
        let bundle_bytes = fs::read(bundle_path).map_err(|error| {
            AppError::local(
                format!("could not read {}: {error}", bundle_path.display()),
                "Check the --bundle path. A bundle is what `memoar convert --target <t>` writes; without one, drop --bundle and let this command fetch it.",
            )
        })?;
        let bundle: ConversionBundle = serde_json::from_slice(&bundle_bytes).map_err(|error| {
            AppError::local(
                format!(
                    "{} is not a conversion bundle: {error}",
                    bundle_path.display()
                ),
                "Point --bundle at the JSON bundle the archive produced for this session.",
            )
        })?;
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
            // The archive read the session and refused to convert it. That is
            // not a network condition: it was reported as one, with
            // `retryable: true` and "check the endpoint, connection, and
            // credentials, then retry" — advice that cannot work, because the
            // next attempt is refused identically. Now that a conversion can
            // fail loudly rather than silently, the two outcomes a person has
            // to act on differently have different codes and exits.
            Some("failed") => {
                return Err(AppError::refused(
                    "MEMOAR_CONVERSION_FAILED",
                    format!(
                        "the archive could not convert session {} to {}: {}",
                        args.session_id,
                        args.target,
                        conversion_refusal(&job)
                    ),
                    "Retrying is refused the same way. Try another --target, or --fallback injection, which converts what the native format cannot carry.",
                ));
            }
            _ if Instant::now() >= deadline => {
                return Err(AppError::timed_out(
                    format!(
                        "conversion job {job_id} for session {} was still {} after {}s",
                        args.session_id,
                        job.get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("unreported"),
                        args.wait_seconds.max(1)
                    ),
                    "The archive accepted the job and is still working; nothing was lost. Retry with a longer --wait-seconds.",
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

/// Why the archive refused, as a sentence.
///
/// The report was interpolated whole, so a refusal reached the terminal as
/// `conversion failed: {"reason":"...","mappedTurns":0,...}` — the same
/// wire-format-on-the-terminal defect already fixed for problem documents.
/// Only the fields meant to be read are read, and when none of them is there
/// the message says so rather than pasting the document.
fn conversion_refusal(job: &Value) -> String {
    let report = job.get("report").unwrap_or(&Value::Null);
    let field = |source: &Value, name: &str| {
        source
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    for name in ["reason", "detail", "error", "message", "title"] {
        if let Some(text) = field(report, name).or_else(|| field(job, name)) {
            return text;
        }
    }
    "the archive did not say why".to_owned()
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
