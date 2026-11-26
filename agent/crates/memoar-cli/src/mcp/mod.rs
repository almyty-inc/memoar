//! `memoar mcp`: the archive's MCP tools, for agents on this computer.
//!
//! With no subcommand it is a stdio MCP server. `tools` and `call` reach the
//! same tools from a shell, which is how an agent that has the skill but no
//! MCP client saves a note or reads an instruction file.

mod proxy;
mod serve;

use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::io::Read;

use crate::CommandOutput;
use crate::config::RuntimePaths;
use crate::error::AppError;

pub(crate) use proxy::McpProxy;
#[cfg(test)]
pub(crate) use proxy::mcp_url;
use serve::serve;
#[cfg(test)]
pub(crate) use serve::serve_streams;

#[derive(Debug, Args)]
pub struct McpArgs {
    #[command(subcommand)]
    pub command: Option<McpCommand>,
}

impl McpArgs {
    /// Whether this invocation is the stdio server, whose standard output is
    /// protocol and must not carry a result envelope.
    #[must_use]
    pub fn serves(&self) -> bool {
        matches!(self.command, None | Some(McpCommand::Serve))
    }
}

#[derive(Debug, Subcommand)]
pub enum McpCommand {
    /// Serve the archive's MCP tools over stdio. What `memoar mcp` does alone.
    Serve,
    /// List the archive's MCP tools with their input schemas.
    Tools,
    /// Call one MCP tool and print its result.
    Call(McpCallArgs),
}

#[derive(Debug, Args)]
pub struct McpCallArgs {
    /// The tool, such as search_sessions or save_note.
    pub tool: String,
    /// The tool's arguments as one JSON object. `-` reads them from standard
    /// input, which keeps a long note out of shell quoting.
    #[arg(default_value = "{}")]
    pub arguments: String,
}

pub(crate) fn mcp(args: &McpArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    match &args.command {
        None | Some(McpCommand::Serve) => {
            serve(paths)?;
            Ok(CommandOutput {
                command: "mcp".to_owned(),
                data: Value::Null,
            })
        }
        Some(McpCommand::Tools) => {
            let result = McpProxy::from_paths(paths)?.request("tools/list", json!({}))?;
            Ok(CommandOutput {
                command: "mcp tools".to_owned(),
                data: result.get("tools").cloned().unwrap_or(json!([])),
            })
        }
        Some(McpCommand::Call(call)) => {
            let arguments = parse_arguments(&call.arguments)?;
            let result = McpProxy::from_paths(paths)?.request(
                "tools/call",
                json!({ "name": call.tool, "arguments": arguments }),
            )?;
            Ok(CommandOutput {
                command: "mcp call".to_owned(),
                data: tool_result(&call.tool, &result)?,
            })
        }
    }
}

fn parse_arguments(text: &str) -> Result<Value, AppError> {
    let text = if text == "-" {
        let mut buffer = String::new();
        std::io::stdin()
            .read_to_string(&mut buffer)
            .map_err(|error| AppError::usage(format!("could not read standard input: {error}")))?;
        buffer
    } else {
        text.to_owned()
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| AppError::usage(format!("the tool arguments are not JSON: {error}")))?;
    if !value.is_object() {
        return Err(AppError::usage(
            "the tool arguments must be one JSON object",
        ));
    }
    Ok(value)
}

/// What a tool answered, as data. A tool that refused is an error here, with
/// the tool's own words, which say what to change.
pub(crate) fn tool_result(tool: &str, result: &Value) -> Result<Value, AppError> {
    let text = result
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if result.get("isError") == Some(&Value::Bool(true)) {
        return Err(AppError::refused(
            "MEMOAR_TOOL_ERROR",
            format!("{tool}: {text}"),
            "Read the tool's message, change the arguments, and call again. memoar mcp tools lists each tool's schema.",
        ));
    }
    if let Some(structured) = result.get("structuredContent") {
        return Ok(structured.clone());
    }
    Ok(serde_json::from_str(text).unwrap_or_else(|_| json!(text)))
}
