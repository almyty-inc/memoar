use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::dirs::{Platform, default_dirs};

fn env(pairs: &[(&str, PathBuf)]) -> impl Fn(&str) -> Option<OsString> {
    let pairs: Vec<(String, PathBuf)> = pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect();
    move |name| {
        pairs
            .iter()
            .find(|(candidate, _)| candidate == name)
            .map(|(_, value)| value.clone().into_os_string())
    }
}

/// `C:\Users\me\.config\memoar` is nowhere a Windows tool looks. The roaming
/// profile holds settings and the local one holds caches and queues.
#[test]
fn windows_uses_the_application_data_folders() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("me");
    let roaming = temp.path().join("Roaming");
    let local = temp.path().join("Local");
    let (config, data) = default_dirs(
        &home,
        Platform::Windows,
        env(&[
            ("APPDATA", roaming.clone()),
            ("LOCALAPPDATA", local.clone()),
        ]),
    );
    assert_eq!(config, roaming.join("memoar"));
    assert_eq!(data, local.join("memoar"));

    let (config, data) = default_dirs(&home, Platform::Windows, env(&[]));
    assert_eq!(config, home.join("AppData").join("Roaming").join("memoar"));
    assert_eq!(data, home.join("AppData").join("Local").join("memoar"));
}

#[test]
fn linux_follows_xdg_and_ignores_a_relative_value() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("me");
    let xdg_config = temp.path().join("xdg-config");
    let xdg_data = temp.path().join("xdg-data");
    let (config, data) = default_dirs(
        &home,
        Platform::OtherUnix,
        env(&[
            ("XDG_CONFIG_HOME", xdg_config.clone()),
            ("XDG_DATA_HOME", xdg_data.clone()),
        ]),
    );
    assert_eq!(config, xdg_config.join("memoar"));
    assert_eq!(data, xdg_data.join("memoar"));

    let (config, _) = default_dirs(
        &home,
        Platform::OtherUnix,
        env(&[("XDG_CONFIG_HOME", PathBuf::from("relative/dir"))]),
    );
    assert_eq!(config, legacy_config(&home));
}

#[test]
fn macos_keeps_the_dot_directories() {
    let home = PathBuf::from("/Users/me");
    let (config, data) = default_dirs(&home, Platform::Macos, env(&[]));
    assert_eq!(config, legacy_config(&home));
    assert_eq!(data, home.join(".local").join("share").join("memoar"));
}

/// Moving an install's credential to a new default would sign it out.
#[test]
fn an_existing_install_stays_where_it_is() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("me");
    fs::create_dir_all(legacy_config(&home)).unwrap();
    fs::write(legacy_config(&home).join("config.json"), "{}").unwrap();
    for platform in [Platform::Windows, Platform::OtherUnix] {
        let (config, data) = default_dirs(
            &home,
            platform,
            env(&[
                ("APPDATA", temp.path().join("Roaming")),
                ("XDG_CONFIG_HOME", temp.path().join("xdg")),
            ]),
        );
        assert_eq!(config, legacy_config(&home), "{platform:?}");
        assert_eq!(data, home.join(".local").join("share").join("memoar"));
    }
}

fn legacy_config(home: &Path) -> PathBuf {
    home.join(".config").join("memoar")
}
