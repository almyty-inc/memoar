//! The shape of a capture source: platforms, stability, declared paths.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stability {
    Internal,
    Stable,
    ReverseEngineered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperatingSystem {
    Linux,
    Macos,
    Windows,
}

impl OperatingSystem {
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SourceSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub tier: u8,
    pub format: &'static str,
    pub stability: Stability,
    pub common_paths: &'static [&'static str],
    pub linux_paths: &'static [&'static str],
    pub macos_paths: &'static [&'static str],
    pub windows_paths: &'static [&'static str],
    pub environment_override: Option<&'static str>,
    /// The home-relative directories `environment_override` stands in for.
    ///
    /// Without these an override was taken as a bare root, and a bare root
    /// means everything beneath it — the same sweep the globs above exist to
    /// prevent, reachable by setting one environment variable.
    pub environment_roots: &'static [&'static str],
}

impl SourceSpec {
    pub fn paths_for(&self, os: OperatingSystem) -> impl Iterator<Item = &'static str> + '_ {
        let platform_paths = match os {
            OperatingSystem::Linux => self.linux_paths,
            OperatingSystem::Macos => self.macos_paths,
            OperatingSystem::Windows => self.windows_paths,
        };
        self.common_paths
            .iter()
            .chain(platform_paths.iter())
            .copied()
    }
}
