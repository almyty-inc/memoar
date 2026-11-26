//! Where each agent's files are on each platform, asked of one Mac.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::dirs::Platform;
use crate::integrate::{AGENTS, Env};

fn config(
    agent: &str,
    home: &Path,
    platform: Platform,
    var: &dyn Fn(&str) -> Option<OsString>,
) -> PathBuf {
    let env = Env {
        home,
        platform,
        var,
    };
    let agent = AGENTS
        .iter()
        .find(|candidate| candidate.id == agent)
        .unwrap();
    (agent.config)(&env)
}

fn skills(agent: &str, home: &Path, var: &dyn Fn(&str) -> Option<OsString>) -> PathBuf {
    let env = Env {
        home,
        platform: Platform::OtherUnix,
        var,
    };
    let agent = AGENTS
        .iter()
        .find(|candidate| candidate.id == agent)
        .unwrap();
    (agent.skills.unwrap())(&env)
}

fn none(_: &str) -> Option<OsString> {
    None
}

#[test]
fn defaults_per_platform() {
    let home = Path::new("/home/dev");
    let mac = |agent| config(agent, home, Platform::Macos, &none);
    let linux = |agent| config(agent, home, Platform::OtherUnix, &none);
    let windows = |agent| config(agent, home, Platform::Windows, &none);

    assert_eq!(mac("claude-code"), home.join(".claude.json"));
    assert_eq!(windows("codex"), home.join(".codex/config.toml"));
    assert_eq!(linux("gemini"), home.join(".gemini/settings.json"));
    assert_eq!(windows("cursor"), home.join(".cursor/mcp.json"));
    assert_eq!(
        windows("opencode"),
        home.join(".config/opencode/opencode.json")
    );
    assert_eq!(mac("goose"), home.join(".config/goose/config.yaml"));
    assert_eq!(
        windows("goose"),
        home.join("AppData/Roaming/Block/goose/config/config.yaml")
    );
    assert_eq!(mac("zed"), home.join(".config/zed/settings.json"));
    assert_eq!(
        windows("zed"),
        home.join("AppData/Roaming/Zed/settings.json")
    );
    assert_eq!(
        mac("vscode"),
        home.join("Library/Application Support/Code/User/mcp.json")
    );
    assert_eq!(linux("vscode"), home.join(".config/Code/User/mcp.json"));
    assert_eq!(
        windows("vscode"),
        home.join("AppData/Roaming/Code/User/mcp.json")
    );
    assert_eq!(
        linux("roo"),
        home.join(
            ".config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json"
        )
    );
    assert_eq!(
        mac("cline"),
        home.join(".cline/data/settings/cline_mcp_settings.json")
    );
    assert_eq!(linux("kilo"), home.join(".config/kilo/kilo.json"));
    assert_eq!(
        mac("windsurf"),
        home.join(".codeium/windsurf/mcp_config.json")
    );
    assert_eq!(
        windows("devin"),
        home.join("AppData/Roaming/devin/mcp_config.json")
    );
    assert_eq!(mac("copilot-cli"), home.join(".copilot/mcp-config.json"));
}

/// An absolute path on the platform the test runs on: `/tmp` is relative on
/// Windows, where an absolute path needs a drive.
fn absolute(path: &str) -> PathBuf {
    let root = if cfg!(windows) { r"C:\" } else { "/" };
    Path::new(root).join(path)
}

#[test]
fn environment_variables_relocate_what_their_tools_say_they_do() {
    let home = Path::new("/home/dev");
    let var = |name: &str| -> Option<OsString> {
        let path = match name {
            "CLAUDE_CONFIG_DIR" => absolute("claude"),
            "CODEX_HOME" => absolute("codex"),
            "XDG_CONFIG_HOME" => absolute("xdg"),
            "APPDATA" => absolute("roaming"),
            "GOOSE_PATH_ROOT" => absolute("goose"),
            "COPILOT_HOME" => absolute("copilot"),
            // Relative, so ignored: it would depend on where memoar ran.
            "GEMINI_CLI_HOME" => PathBuf::from("relative"),
            _ => return None,
        };
        Some(path.into_os_string())
    };
    let linux = |agent| config(agent, home, Platform::OtherUnix, &var);
    assert_eq!(linux("claude-code"), absolute("claude/.claude.json"));
    assert_eq!(skills("claude-code", home, &var), absolute("claude/skills"));
    assert_eq!(linux("codex"), absolute("codex/config.toml"));
    assert_eq!(linux("opencode"), absolute("xdg/opencode/opencode.json"));
    assert_eq!(linux("zed"), absolute("xdg/zed/settings.json"));
    assert_eq!(linux("goose"), absolute("goose/config/config.yaml"));
    assert_eq!(linux("gemini"), home.join(".gemini/settings.json"));
    assert_eq!(linux("copilot-cli"), absolute("copilot/mcp-config.json"));
    assert_eq!(skills("vscode", home, &var), absolute("copilot/skills"));
    assert_eq!(
        config("vscode", home, Platform::Windows, &var),
        absolute("roaming/Code/User/mcp.json")
    );
    // Codex reads ~/.agents/skills, not CODEX_HOME, for user skills.
    assert_eq!(skills("codex", home, &var), home.join(".agents/skills"));
}

#[test]
fn an_existing_jsonc_file_is_the_one_edited() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".config/opencode");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("opencode.jsonc"), "{}").unwrap();
    assert_eq!(
        config("opencode", temp.path(), Platform::Macos, &none),
        directory.join("opencode.jsonc")
    );
}

#[test]
fn every_agent_has_a_unique_id_and_alias() {
    let mut names: Vec<&str> = AGENTS
        .iter()
        .flat_map(|agent| std::iter::once(agent.id).chain(agent.aliases.iter().copied()))
        .collect();
    let count = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), count);
    assert!(!names.contains(&"all"), "all selects every agent");
}
