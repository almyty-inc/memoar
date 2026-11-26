//! `memoar integrate`: give a coding agent the archive as memory.
//!
//! For each agent named it does two things: registers `memoar mcp` as a stdio
//! MCP server in that agent's own config file, and installs the
//! `memoar-memory` skill where that agent loads skills from. Existing config is
//! merged, never replaced: only memoar's own entry changes, a changed file is
//! backed up first, and a second run changes nothing. `--dry-run` reports the
//! plan and writes nothing, and `--uninstall` takes both back out.

mod agents;
mod catalog;
pub(crate) mod json_file;
mod plan;
pub(crate) mod skill;
pub(crate) mod toml_file;
mod write;
pub(crate) mod yaml_file;

use clap::Args;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::PathBuf;

use crate::CommandOutput;
use crate::args::Cli;
use crate::config::RuntimePaths;
use crate::dirs::Platform;
use crate::error::AppError;

pub(crate) use agents::{AGENTS, Agent, Env, Launch};
use write::{Action, FileChange, FileOp};

#[derive(Debug, Args)]
pub struct IntegrateArgs {
    /// Agents to register with, such as claude-code or codex. `all` means
    /// every supported agent found on this computer. Leave it out to list them.
    pub agents: Vec<String>,
    /// Report what would change and write nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// Remove memoar's MCP entry and skill instead.
    #[arg(long)]
    pub uninstall: bool,
    /// Only the MCP server, not the skill.
    #[arg(long, conflicts_with = "skill_only")]
    pub mcp_only: bool,
    /// Only the skill, not the MCP server.
    #[arg(long)]
    pub skill_only: bool,
    /// The program agents launch for the MCP server. Defaults to the absolute
    /// path of this memoar binary, because an editor started from a desktop
    /// launcher does not see the shell's PATH.
    #[arg(long, value_name = "PATH")]
    pub command: Option<String>,
}

pub(crate) fn integrate(
    args: &IntegrateArgs,
    cli: &Cli,
    paths: &RuntimePaths,
) -> Result<CommandOutput, AppError> {
    let variable = |name: &str| std::env::var_os(name);
    let env = Env {
        home: &paths.home,
        platform: Platform::current(),
        var: &variable,
    };
    let launch = launch(args, cli)?;
    let data = run(args, &env, &launch)?;
    Ok(CommandOutput {
        command: "integrate".to_owned(),
        data,
    })
}

/// The whole command against a given environment, so a test can ask about
/// Windows paths on a Mac.
pub(crate) fn run(args: &IntegrateArgs, env: &Env<'_>, launch: &Launch) -> Result<Value, AppError> {
    if args.agents.is_empty() {
        return Ok(list(env, launch));
    }
    let chosen = choose(&args.agents, env)?;
    // Every file for every agent is worked out before the first is written, so
    // one config this cannot parse leaves all of them untouched.
    let mut planned = Vec::new();
    for agent in &chosen {
        planned.push((*agent, plan_agent(agent, env, launch, args)?));
    }
    let mut reports = Vec::new();
    let mut applied = HashSet::new();
    for (agent, (mcp, skill)) in planned {
        let mut report = json!({ "agent": agent.id, "name": agent.name });
        if let Some(op) = mcp {
            let change = op.apply(args.dry_run)?;
            report["mcp"] = json!({
                "change": change,
                "entry": plan::snippet(agent, launch),
                "format": agent.format.label(),
            });
        }
        if let Some(ops) = skill {
            let changes = ops
                .iter()
                .map(|op| {
                    // Most agents share ~/.agents/skills. The first agent to
                    // reach a file changes it, and the rest find it done.
                    if !applied.insert(op.path().to_owned()) {
                        return Ok(FileChange {
                            path: op.path().to_owned(),
                            action: Action::Unchanged,
                            backup: None,
                        });
                    }
                    op.apply(args.dry_run)
                })
                .collect::<Result<Vec<_>, _>>()?;
            if args.uninstall
                && !args.dry_run
                && let Some(skills) = agent.skills
            {
                skill::remove_empty_directories(&skills(env));
            }
            report["skill"] = json!({ "files": changes });
        } else if !args.mcp_only && agent.skills.is_none() {
            report["skill"] = json!({ "supported": false });
        }
        if let Some(note) = agent.note {
            report["note"] = json!(note);
        }
        reports.push(report);
    }
    Ok(json!({
        "dryRun": args.dry_run,
        "uninstall": args.uninstall,
        "agents": reports,
    }))
}

type Planned = (Option<FileOp>, Option<Vec<FileOp>>);

fn plan_agent(
    agent: &Agent,
    env: &Env<'_>,
    launch: &Launch,
    args: &IntegrateArgs,
) -> Result<Planned, AppError> {
    let mcp = if args.skill_only {
        None
    } else {
        Some(plan::plan_mcp(agent, env, launch, args.uninstall)?)
    };
    let skill = match agent.skills {
        Some(skills) if !args.mcp_only => Some(if args.uninstall {
            skill::plan_uninstall(&skills(env))
        } else {
            skill::plan_install(&skills(env))?
        }),
        _ => None,
    };
    Ok((mcp, skill))
}

fn choose<'a>(names: &[String], env: &Env<'_>) -> Result<Vec<&'a Agent>, AppError> {
    if names.iter().any(|name| name == "all") {
        return Ok(AGENTS
            .iter()
            .filter(|agent| (agent.detect)(env).exists())
            .collect());
    }
    names
        .iter()
        .map(|name| {
            AGENTS
                .iter()
                .find(|agent| agent.id == name || agent.aliases.contains(&name.as_str()))
                .ok_or_else(|| {
                    let known: Vec<_> = AGENTS.iter().map(|agent| agent.id).collect();
                    AppError::usage(format!(
                        "no agent called {name}. Supported: {}, or all",
                        known.join(", ")
                    ))
                })
        })
        .collect()
}

/// Every supported agent, where its files are, and what memoar finds in them.
fn list(env: &Env<'_>, launch: &Launch) -> Value {
    let agents: Vec<Value> = AGENTS
        .iter()
        .map(|agent| {
            let skill = agent.skills.map(|skills| {
                let directory = skills(env);
                let (present, current) = skill::status(&directory);
                json!({
                    "path": directory.join(skill::SKILL_NAME),
                    "status": if current { "current" } else if present { "different" } else { "missing" },
                })
            });
            json!({
                "agent": agent.id,
                "name": agent.name,
                "detected": (agent.detect)(env).exists(),
                "mcp": {
                    "path": (agent.config)(env),
                    "format": agent.format.label(),
                    "status": plan::mcp_status(agent, env, launch),
                },
                "skill": skill,
            })
        })
        .collect();
    json!({ "agents": agents, "launch": launch })
}

/// What the agents run: this binary, with the directories this invocation was
/// given, so a `--config-dir` install serves its own credential.
fn launch(args: &IntegrateArgs, cli: &Cli) -> Result<Launch, AppError> {
    let command = match &args.command {
        Some(command) => command.clone(),
        None => std::env::current_exe()
            .and_then(|path| path.canonicalize())
            .map_err(|error| {
                AppError::local(
                    format!("could not find this program's own path: {error}"),
                    "Pass --command with the path agents should run.",
                )
            })?
            .display()
            .to_string(),
    };
    let mut arguments = Vec::new();
    for (flag, value) in [
        ("--config-dir", &cli.config_dir),
        ("--data-dir", &cli.data_dir),
    ] {
        if let Some(path) = value {
            arguments.push(flag.to_owned());
            arguments.push(absolute(path).display().to_string());
        }
    }
    arguments.push("mcp".to_owned());
    Ok(Launch {
        command,
        args: arguments,
    })
}

fn absolute(path: &std::path::Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_owned())
}
