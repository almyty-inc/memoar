//! Where the app keeps configuration, queue and the home it captures from.
//!
//! The same directories the CLI uses, resolved by the CLI's own code and from
//! the same environment variables, so a machine set up with one is already set
//! up for the other and the offline queue is never duplicated.

use std::ffi::OsString;
use std::path::PathBuf;

use memoar_cli::{Cli, Command, RuntimePaths};

/// The variables the CLI reads for `--config-dir`, `--data-dir` and
/// `--capture-home`. Setting them points the app at scratch directories, which
/// is how the headless tests run without touching a real configuration.
pub const CONFIG_DIR_VAR: &str = "MEMOAR_CONFIG_DIR";
pub const DATA_DIR_VAR: &str = "MEMOAR_DATA_DIR";
pub const CAPTURE_HOME_VAR: &str = "MEMOAR_CAPTURE_HOME";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub home: PathBuf,
}

impl Paths {
    /// # Errors
    /// When the home directory cannot be resolved.
    pub fn resolve() -> Result<Self, String> {
        Self::resolve_with(|name| std::env::var_os(name))
    }

    /// Resolves with `lookup` standing in for the environment.
    ///
    /// Taking the lookup rather than reading the process environment keeps the
    /// tests from racing each other over process-wide variables.
    ///
    /// # Errors
    /// When the home directory cannot be resolved.
    pub fn resolve_with(lookup: impl Fn(&str) -> Option<OsString>) -> Result<Self, String> {
        let set = |name: &str| {
            lookup(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        let mut cli = base_cli(Command::Status);
        cli.config_dir = set(CONFIG_DIR_VAR);
        cli.data_dir = set(DATA_DIR_VAR);
        cli.capture_home = set(CAPTURE_HOME_VAR);
        let paths = RuntimePaths::resolve(&cli).map_err(|error| error.message.clone())?;
        Ok(Self {
            config_dir: paths.config_dir,
            data_dir: paths.data_dir,
            home: paths.home,
        })
    }

    pub(crate) fn runtime(&self) -> RuntimePaths {
        RuntimePaths {
            config_dir: self.config_dir.clone(),
            data_dir: self.data_dir.clone(),
            home: self.home.clone(),
        }
    }

    /// The file `memoar login` writes the machine's credential to.
    #[must_use]
    pub fn credentials_file(&self) -> PathBuf {
        self.config_dir.join("credentials.json")
    }
}

/// A CLI invocation with no flags of its own: the paths come from [`Paths`].
pub(crate) fn base_cli(command: Command) -> Cli {
    Cli {
        json: true,
        config_dir: None,
        data_dir: None,
        capture_home: None,
        command,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cli_variables_override_every_directory() {
        let paths = Paths::resolve_with(|name| match name {
            CONFIG_DIR_VAR => Some("/scratch/config".into()),
            DATA_DIR_VAR => Some("/scratch/data".into()),
            CAPTURE_HOME_VAR => Some("/scratch/home".into()),
            _ => None,
        })
        .unwrap();

        assert_eq!(paths.config_dir, PathBuf::from("/scratch/config"));
        assert_eq!(paths.data_dir, PathBuf::from("/scratch/data"));
        assert_eq!(paths.home, PathBuf::from("/scratch/home"));
        assert_eq!(
            paths.credentials_file(),
            PathBuf::from("/scratch/config/credentials.json")
        );
    }

    #[test]
    fn an_empty_variable_is_no_override() {
        let paths =
            Paths::resolve_with(|name| (name == CONFIG_DIR_VAR).then(OsString::new)).unwrap();

        // The CLI's default differs by platform (`~/.config/memoar`, the XDG
        // directory, or `%APPDATA%\memoar`), so compare with what it resolves
        // when the variable is absent rather than with one of those spellings.
        let default = Paths::resolve_with(|_| None).unwrap();
        assert_eq!(
            paths.config_dir, default.config_dir,
            "an empty value must fall back to the CLI's default, not the working directory"
        );
        assert!(paths.config_dir.is_absolute());
        assert!(paths.config_dir.ends_with("memoar"));
    }

    #[test]
    fn the_runtime_paths_are_the_same_directories() {
        let paths = Paths {
            config_dir: "/a".into(),
            data_dir: "/b".into(),
            home: "/c".into(),
        };
        let runtime = paths.runtime();

        assert_eq!(runtime.config_dir, paths.config_dir);
        assert_eq!(runtime.data_dir, paths.data_dir);
        assert_eq!(runtime.home, paths.home);
    }
}
