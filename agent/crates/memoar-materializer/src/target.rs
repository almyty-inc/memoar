//! The gated conversion targets and their wire names.

use serde::{Deserialize, Serialize};
use std::str::FromStr;

use crate::error::MaterializeError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Target {
    ClaudeCode,
    Codex,
    AntigravityCli,
}

impl Target {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::AntigravityCli => "antigravity-cli",
        }
    }
}

impl FromStr for Target {
    type Err = MaterializeError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            "antigravity-cli" => Ok(Self::AntigravityCli),
            other => Err(MaterializeError::UnsupportedTarget(other.to_owned())),
        }
    }
}
