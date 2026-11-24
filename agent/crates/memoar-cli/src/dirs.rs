//! Where configuration and the queue live when nobody says.
//!
//! Every platform got `~/.config/memoar` and `~/.local/share/memoar`. On
//! Windows that put a `.config` and a `.local` folder in the user's profile,
//! where nothing else on that platform keeps anything, and outside the roaming
//! and local application data folders that backup, profile migration and
//! cleanup tools know about. On Linux it ignored `XDG_CONFIG_HOME` and
//! `XDG_DATA_HOME`, which is how a person moves both elsewhere.
//!
//! An install that already has `~/.config/memoar/config.json` keeps using the
//! old place, so this moves nobody's credential out from under them.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The platform rules, separated from the process so a test can ask about
/// Windows on a Mac.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Platform {
    Windows,
    Macos,
    OtherUnix,
}

impl Platform {
    pub(crate) fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::OtherUnix
        }
    }
}

/// The config and data directories for this user.
pub(crate) fn default_dirs(
    home: &Path,
    platform: Platform,
    environment: impl Fn(&str) -> Option<OsString>,
) -> (PathBuf, PathBuf) {
    let legacy_config = home.join(".config").join("memoar");
    let legacy_data = home.join(".local").join("share").join("memoar");
    if legacy_config.join("config.json").exists() {
        return (legacy_config, legacy_data);
    }
    // Only an absolute value counts, as the XDG specification says: a relative
    // one would resolve against whatever directory the command ran in.
    let absolute = |name: &str| {
        environment(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    match platform {
        Platform::Windows => (
            absolute("APPDATA")
                .unwrap_or_else(|| home.join("AppData").join("Roaming"))
                .join("memoar"),
            absolute("LOCALAPPDATA")
                .unwrap_or_else(|| home.join("AppData").join("Local"))
                .join("memoar"),
        ),
        Platform::OtherUnix => (
            absolute("XDG_CONFIG_HOME").map_or(legacy_config, |root| root.join("memoar")),
            absolute("XDG_DATA_HOME").map_or(legacy_data, |root| root.join("memoar")),
        ),
        Platform::Macos => (legacy_config, legacy_data),
    }
}
