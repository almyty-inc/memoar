//! The coding agents `integrate` knows, and where each keeps its files.
//!
//! Every path and entry shape here was taken from the agent's own
//! documentation or source. `docs/agent-integration.md` lists the source for
//! each one. Paths are worked out from the platform and the environment that
//! are passed in, never from the running process, so a test can check the
//! Windows answer on a Mac.

use serde::Serialize;
use serde_json::{Value, json};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::dirs::Platform;

/// The name memoar's entry has in every agent's config.
pub(crate) const SERVER_NAME: &str = "memoar";

/// The program an agent starts, and its arguments.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct Launch {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
}

pub(crate) struct Env<'a> {
    pub(crate) home: &'a Path,
    pub(crate) platform: Platform,
    pub(crate) var: &'a dyn Fn(&str) -> Option<OsString>,
}

impl Env<'_> {
    /// An environment variable naming a directory. Only an absolute one
    /// counts, since a relative one would depend on where memoar ran.
    fn dir(&self, name: &str) -> Option<PathBuf> {
        (self.var)(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    }

    /// `XDG_CONFIG_HOME`, or `~/.config`. Tools built on XDG conventions use
    /// it on macOS too, and some on Windows.
    fn xdg_config(&self) -> PathBuf {
        self.dir("XDG_CONFIG_HOME")
            .unwrap_or_else(|| self.home.join(".config"))
    }

    /// `%APPDATA%`, the roaming application data folder.
    fn appdata(&self) -> PathBuf {
        self.dir("APPDATA")
            .unwrap_or_else(|| self.home.join("AppData").join("Roaming"))
    }

    /// Where an Electron application such as VS Code keeps user data.
    fn electron_user_data(&self, product: &str) -> PathBuf {
        match self.platform {
            Platform::Macos => self
                .home
                .join("Library")
                .join("Application Support")
                .join(product),
            Platform::Windows => self.appdata().join(product),
            Platform::OtherUnix => self.xdg_config().join(product),
        }
    }

    fn vscode_user(&self) -> PathBuf {
        self.electron_user_data("Code").join("User")
    }

    pub(crate) fn claude_dir(&self) -> PathBuf {
        self.dir("CLAUDE_CONFIG_DIR")
            .unwrap_or_else(|| self.home.join(".claude"))
    }

    /// `~/.claude.json`, or the same file inside `CLAUDE_CONFIG_DIR`.
    pub(crate) fn claude_json(&self) -> PathBuf {
        self.dir("CLAUDE_CONFIG_DIR").map_or_else(
            || self.home.join(".claude.json"),
            |dir| dir.join(".claude.json"),
        )
    }

    pub(crate) fn codex_home(&self) -> PathBuf {
        self.dir("CODEX_HOME")
            .unwrap_or_else(|| self.home.join(".codex"))
    }

    pub(crate) fn gemini_dir(&self) -> PathBuf {
        self.dir("GEMINI_CLI_HOME")
            .unwrap_or_else(|| self.home.to_owned())
            .join(".gemini")
    }

    /// The user-level skills directory most agents now share.
    pub(crate) fn shared_skills(&self) -> PathBuf {
        self.home.join(".agents").join("skills")
    }

    /// `opencode` or `kilo` under the XDG config root. An existing `.jsonc`
    /// is the file to edit, and a new install gets `.json`.
    pub(crate) fn xdg_json(&self, tool: &str, stem: &str) -> PathBuf {
        let directory = self.xdg_config().join(tool);
        let commented = directory.join(format!("{stem}.jsonc"));
        if commented.exists() {
            return commented;
        }
        directory.join(format!("{stem}.json"))
    }

    pub(crate) fn opencode_dir(&self) -> PathBuf {
        self.xdg_config().join("opencode")
    }

    pub(crate) fn kilo_dir(&self) -> PathBuf {
        self.xdg_config().join("kilo")
    }

    pub(crate) fn goose_config_dir(&self) -> PathBuf {
        if let Some(root) = self.dir("GOOSE_PATH_ROOT") {
            return root.join("config");
        }
        match self.platform {
            Platform::Windows => self.appdata().join("Block").join("goose").join("config"),
            Platform::Macos | Platform::OtherUnix => self.xdg_config().join("goose"),
        }
    }

    pub(crate) fn zed_dir(&self) -> PathBuf {
        match self.platform {
            Platform::Windows => self.appdata().join("Zed"),
            Platform::Macos => self.home.join(".config").join("zed"),
            Platform::OtherUnix => self.xdg_config().join("zed"),
        }
    }

    pub(crate) fn vscode_global_storage(&self, extension: &str) -> PathBuf {
        self.vscode_user().join("globalStorage").join(extension)
    }

    pub(crate) fn vscode_user_dir(&self) -> PathBuf {
        self.vscode_user()
    }

    pub(crate) fn devin_dir(&self) -> PathBuf {
        match self.platform {
            Platform::Windows => self.appdata().join("devin"),
            Platform::Macos | Platform::OtherUnix => self.home.join(".config").join("devin"),
        }
    }

    pub(crate) fn cline_data(&self) -> PathBuf {
        if let Some(data) = self.dir("CLINE_DATA_DIR") {
            return data;
        }
        self.cline_dir().join("data")
    }

    pub(crate) fn cline_dir(&self) -> PathBuf {
        self.dir("CLINE_DIR")
            .unwrap_or_else(|| self.home.join(".cline"))
    }

    pub(crate) fn copilot_home(&self) -> PathBuf {
        self.dir("COPILOT_HOME")
            .unwrap_or_else(|| self.home.join(".copilot"))
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Format {
    /// A JSON or JSONC file, with servers in the object at this key path.
    Json(&'static [&'static str]),
    /// A TOML file, with servers in this table.
    Toml(&'static str),
    /// Goose's YAML, with servers in this top-level map.
    Yaml(&'static str),
}

impl Format {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Json(_) => "json",
            Self::Toml(_) => "toml",
            Self::Yaml(_) => "yaml",
        }
    }
}

pub(crate) struct Agent {
    pub(crate) id: &'static str,
    pub(crate) aliases: &'static [&'static str],
    pub(crate) name: &'static str,
    pub(crate) format: Format,
    /// The user-level MCP config file.
    pub(crate) config: fn(&Env<'_>) -> PathBuf,
    /// The directory skills are loaded from, when the agent loads skills.
    pub(crate) skills: Option<fn(&Env<'_>) -> PathBuf>,
    /// A directory whose existence means the agent is installed here.
    pub(crate) detect: fn(&Env<'_>) -> PathBuf,
    pub(crate) entry: fn(&Launch) -> Value,
    /// Something a person should know about this agent's integration.
    pub(crate) note: Option<&'static str>,
}

/// `{ command, args }`, the shape most agents share.
pub(crate) fn plain(launch: &Launch) -> Value {
    json!({ "command": launch.command, "args": launch.args })
}

/// `{ type: "stdio", command, args }`.
pub(crate) fn typed_stdio(launch: &Launch) -> Value {
    json!({ "type": "stdio", "command": launch.command, "args": launch.args })
}

/// The program and its arguments as one list, which is how OpenCode takes it.
pub(crate) fn command_line(launch: &Launch) -> Vec<String> {
    let mut line = vec![launch.command.clone()];
    line.extend(launch.args.iter().cloned());
    line
}

pub(crate) use super::catalog::AGENTS;
