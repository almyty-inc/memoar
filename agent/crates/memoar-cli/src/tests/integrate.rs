//! `memoar integrate` against a throwaway home: merge, back up, idempotent,
//! dry run, uninstall, and nothing written when one file cannot be parsed.

use serde_json::Value;
use std::ffi::OsString;
use std::fs;
use std::path::Path;

use crate::dirs::Platform;
use crate::integrate::skill::SKILL_FILES;
use crate::integrate::{Env, IntegrateArgs, Launch, run};

fn no_variables(_: &str) -> Option<OsString> {
    None
}

fn env(home: &Path) -> Env<'_> {
    Env {
        home,
        platform: Platform::Macos,
        var: &no_variables,
    }
}

fn launch() -> Launch {
    Launch {
        command: "/opt/memoar/bin/memoar".to_owned(),
        args: vec!["mcp".to_owned()],
    }
}

fn args(agents: &[&str]) -> IntegrateArgs {
    IntegrateArgs {
        agents: agents.iter().map(|agent| (*agent).to_owned()).collect(),
        dry_run: false,
        uninstall: false,
        mcp_only: false,
        skill_only: false,
        command: None,
    }
}

fn mcp_action(report: &Value, index: usize) -> &str {
    report["agents"][index]["mcp"]["change"]["action"]
        .as_str()
        .unwrap()
}

#[test]
fn installs_merges_and_is_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let claude = home.join(".claude.json");
    fs::write(
        &claude,
        r#"{"numStartups": 7, "mcpServers": {"other": {"command": "x"}}}"#,
    )
    .unwrap();

    let first = run(&args(&["claude-code", "codex"]), &env(home), &launch()).unwrap();
    assert_eq!(mcp_action(&first, 0), "updated");
    assert_eq!(mcp_action(&first, 1), "created");
    let backup = first["agents"][0]["mcp"]["change"]["backup"]
        .as_str()
        .expect("a changed file is backed up");
    assert!(fs::read_to_string(backup).unwrap().contains("numStartups"));

    let written: Value = serde_json::from_str(&fs::read_to_string(&claude).unwrap()).unwrap();
    assert_eq!(written["numStartups"], 7);
    assert_eq!(written["mcpServers"]["other"]["command"], "x");
    assert_eq!(
        written["mcpServers"]["memoar"]["command"],
        "/opt/memoar/bin/memoar"
    );
    assert_eq!(written["mcpServers"]["memoar"]["type"], "stdio");
    let skill = home.join(".claude/skills/memoar-memory/SKILL.md");
    assert_eq!(fs::read_to_string(skill).unwrap(), SKILL_FILES[0].1);
    assert!(home.join(".agents/skills/memoar-memory/SKILL.md").exists());
    let codex = fs::read_to_string(home.join(".codex/config.toml")).unwrap();
    assert!(codex.contains("[mcp_servers.memoar]"));

    let second = run(&args(&["claude-code", "codex"]), &env(home), &launch()).unwrap();
    assert_eq!(mcp_action(&second, 0), "unchanged");
    assert_eq!(mcp_action(&second, 1), "unchanged");
    assert!(second["agents"][0]["mcp"]["change"].get("backup").is_none());
    for file in second["agents"][1]["skill"]["files"].as_array().unwrap() {
        assert_eq!(file["action"], "unchanged");
    }
}

#[test]
fn dry_run_writes_nothing() {
    let temp = tempfile::tempdir().unwrap();
    let mut dry = args(&["cursor", "gemini"]);
    dry.dry_run = true;
    let report = run(&dry, &env(temp.path()), &launch()).unwrap();
    assert_eq!(mcp_action(&report, 0), "created");
    assert_eq!(
        report["agents"][0]["mcp"]["entry"]["command"],
        "/opt/memoar/bin/memoar"
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn uninstall_takes_out_only_memoar() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let cursor = home.join(".cursor/mcp.json");
    fs::create_dir_all(cursor.parent().unwrap()).unwrap();
    fs::write(&cursor, r#"{"mcpServers": {"other": {"command": "x"}}}"#).unwrap();
    let skills = home.join(".agents/skills/memoar-memory");
    fs::create_dir_all(&skills).unwrap();
    fs::write(skills.join("notes-of-my-own.md"), "keep").unwrap();
    run(&args(&["cursor"]), &env(home), &launch()).unwrap();

    let mut remove = args(&["cursor"]);
    remove.uninstall = true;
    let report = run(&remove, &env(home), &launch()).unwrap();
    assert_eq!(mcp_action(&report, 0), "removed");
    let left: Value = serde_json::from_str(&fs::read_to_string(&cursor).unwrap()).unwrap();
    assert!(left["mcpServers"].get("memoar").is_none());
    assert_eq!(left["mcpServers"]["other"]["command"], "x");
    assert!(!skills.join("SKILL.md").exists());
    assert!(
        skills.join("notes-of-my-own.md").exists(),
        "not memoar's to delete"
    );

    let again = run(&remove, &env(home), &launch()).unwrap();
    assert_eq!(mcp_action(&again, 0), "absent");
}

#[test]
fn one_unreadable_config_stops_the_run_before_any_write() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let gemini = home.join(".gemini/settings.json");
    fs::create_dir_all(gemini.parent().unwrap()).unwrap();
    fs::write(&gemini, "{ this is not json").unwrap();

    let error = run(&args(&["cursor", "gemini"]), &env(home), &launch()).unwrap_err();
    assert!(error.message.contains("settings.json"), "{}", error.message);
    assert!(
        !home.join(".cursor").exists(),
        "cursor was planned first and must not be written"
    );
    assert_eq!(fs::read_to_string(&gemini).unwrap(), "{ this is not json");
}

#[test]
fn all_means_the_agents_found_here_and_names_are_checked() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    fs::create_dir_all(home.join(".codex")).unwrap();
    let mut dry = args(&["all"]);
    dry.dry_run = true;
    let report = run(&dry, &env(home), &launch()).unwrap();
    let agents: Vec<_> = report["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|agent| agent["agent"].as_str().unwrap())
        .collect();
    assert_eq!(agents, ["codex"]);

    let error = run(&args(&["notepad"]), &env(home), &launch()).unwrap_err();
    assert!(error.message.contains("claude-code"), "{}", error.message);
}

#[test]
fn listing_reports_what_is_installed() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    run(&args(&["zed"]), &env(home), &launch()).unwrap();
    let listing = run(&args(&[]), &env(home), &launch()).unwrap();
    let zed = listing["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["agent"] == "zed")
        .unwrap();
    assert_eq!(zed["mcp"]["status"], "current");
    assert_eq!(zed["skill"]["status"], "current");
    assert_eq!(zed["detected"], true);
    let other = Launch {
        command: "/elsewhere/memoar".to_owned(),
        args: vec!["mcp".to_owned()],
    };
    let moved = run(&args(&[]), &env(home), &other).unwrap();
    let zed = moved["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["agent"] == "zed")
        .unwrap();
    assert_eq!(zed["mcp"]["status"], "different");
}
