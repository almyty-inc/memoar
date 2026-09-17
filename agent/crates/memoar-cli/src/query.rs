use serde_json::json;

use crate::CommandOutput;
use crate::api::ApiClient;
use crate::args::{PackArgs, SearchArgs, ViewArgs};
use crate::config::{RuntimePaths, authenticated_config};
use crate::error::AppError;

pub(crate) fn search(args: &SearchArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    if !matches!(args.mode.as_str(), "hybrid" | "lexical" | "semantic") {
        return Err(AppError::usage(
            "--mode must be hybrid, lexical, or semantic",
        ));
    }
    let (config, token) = authenticated_config(paths)?;
    let mut query = vec![
        ("q", args.query.clone()),
        ("mode", args.mode.clone()),
        ("limit", args.limit.to_string()),
    ];
    if let Some(agent) = &args.agent {
        query.push(("agent", agent.clone()));
    }
    if let Some(workspace) = &args.workspace {
        query.push(("workspace", workspace.clone()));
    }
    let data = ApiClient::new(&config.endpoint, Some(&token)).get_query("/search", &query)?;
    Ok(CommandOutput {
        command: "search".to_owned(),
        data,
    })
}

pub(crate) fn view(args: &ViewArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    let (config, token) = authenticated_config(paths)?;
    let mut query = vec![("chunkSize", args.chunk_size.to_string())];
    if let Some(cursor) = &args.cursor {
        query.push(("cursor", cursor.clone()));
    }
    let data = ApiClient::new(&config.endpoint, Some(&token))
        .get_query(&format!("/sessions/{}", args.session_id), &query)?;
    Ok(CommandOutput {
        command: "view".to_owned(),
        data,
    })
}

pub(crate) fn pack(args: &PackArgs, paths: &RuntimePaths) -> Result<CommandOutput, AppError> {
    if !matches!(args.freshness_policy.as_str(), "strict" | "mixed") {
        return Err(AppError::usage(
            "--freshness-policy must be strict or mixed",
        ));
    }
    let (config, token) = authenticated_config(paths)?;
    let mut request = json!({
        "query": args.query,
        "maxTokens": args.max_tokens,
        "maxEvidence": args.max_evidence,
        "maxSessions": args.max_sessions,
        "maxExcerptChars": args.max_excerpt_chars,
        "freshnessPolicy": args.freshness_policy
    });
    if let Some(days) = args.stale_after_days {
        request["staleAfterDays"] = json!(days);
    }
    let data = ApiClient::new(&config.endpoint, Some(&token)).post("/pack", &request)?;
    Ok(CommandOutput {
        command: "pack".to_owned(),
        data,
    })
}
