//! `memoar memory convert` — the same instructions, in another tool's dialect.

use memoar_materializer::{
    MemoryConversionBundle, materialize_memory_bundle, memory_bundle_preview,
};
use serde_json::json;
use std::path::Path;

use crate::CommandOutput;
use crate::api::ApiClient;
use crate::args::{MemoryCommand, MemoryConvertArgs};
use crate::config::{RuntimePaths, authenticated_config};
use crate::error::{AppError, map_materialize_error};

pub(crate) fn memory(
    command: &MemoryCommand,
    paths: &RuntimePaths,
) -> Result<CommandOutput, AppError> {
    match command {
        MemoryCommand::Convert(args) => convert(args, paths),
    }
}

fn convert(args: &MemoryConvertArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    if !matches!(args.scope.as_str(), "global" | "project") {
        return Err(AppError::usage("--scope must be global or project"));
    }
    // Checked before the request rather than after it: a project port has
    // nowhere to land without this, and finding that out only once the archive
    // has answered means telling somebody their conversion worked and then
    // refusing to write it.
    if args.scope == "project" && args.workspace.is_none() {
        return Err(AppError::usage(
            "--scope project needs --workspace: those files belong to one repository",
        ));
    }
    let workspace = args
        .workspace
        .as_deref()
        .map(canonical_workspace)
        .transpose()?;
    let (config, token) = authenticated_config(paths)?;
    let api = ApiClient::new(&config.endpoint, Some(&token));
    let response = api.post(
        "/memory/conversions",
        &json!({
            "source": args.source,
            "target": args.target,
            "scope": args.scope,
            "workspacePath": workspace.as_ref().map(|path| path.display().to_string()),
            "machineId": args.machine_id,
        }),
    )?;
    if !args.here {
        return Ok(CommandOutput {
            command: "memory convert".to_owned(),
            data: response,
        });
    }
    let bundle: MemoryConversionBundle = serde_json::from_value(response)
        .map_err(|error| AppError::network(format!("invalid memory conversion bundle: {error}")))?;
    if bundle.target.as_str() != args.target {
        return Err(AppError::network(
            "the archive answered with a different target than the one asked for",
        ));
    }
    let preview = memory_bundle_preview(&bundle);
    let result = materialize_memory_bundle(&bundle, &paths.home, workspace.as_deref())
        .map_err(map_materialize_error)?;
    Ok(CommandOutput {
        command: "memory convert".to_owned(),
        data: json!({
            "bundle": preview,
            "result": serde_json::to_value(result)
                .map_err(|error| AppError::internal(error.to_string()))?,
        }),
    })
}

/// The workspace as the filesystem knows it.
///
/// Resolved here, once, and used both as the filter the archive applies and as
/// the directory the files are written into — the same path in both roles,
/// because a port that selects one repository's files and writes them into
/// another is the worst thing this command could quietly do.
fn canonical_workspace(path: &Path) -> Result<std::path::PathBuf, AppError> {
    path.canonicalize()
        .map_err(|error| AppError::usage(format!("could not resolve {}: {error}", path.display())))
}
