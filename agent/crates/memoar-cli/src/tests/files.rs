use std::fs;

use super::mock::{configured_paths, fixture_paths, spawn_mock_api};
use crate::args::{LoginArgs, SourcesCommand, SyncArgs};
use crate::config::load_config;
use crate::error::{EXIT_LOCKED, EXIT_NOT_INITIALIZED};
use crate::lock::acquire_sync_lock;
use crate::login::login;
use crate::settings::sources;
use crate::status::status;
use crate::sync::sync;

fn one_shot() -> SyncArgs {
    SyncArgs {
        watch: false,
        interval_seconds: 1,
        debounce_seconds: 1,
        max_cycles: 0,
        ..SyncArgs::default()
    }
}

/// A damaged config was `MEMOAR_UNKNOWN`, exit 9, "run memoar doctor", and
/// `doctor` failed on the same file before checking anything.
#[test]
fn a_damaged_config_or_credential_says_so_and_points_at_login() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");
    fs::write(paths.config_file(), "garbage{").unwrap();
    let error = status(&paths).unwrap_err();
    assert_eq!(error.code, "MEMOAR_CONFIG_DAMAGED");
    assert_eq!(error.exit_code, EXIT_NOT_INITIALIZED);
    assert!(error.hint.contains("memoar login"), "{}", error.hint);

    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");
    fs::write(paths.credentials_file(), "").unwrap();
    assert_eq!(status(&paths).unwrap_err().code, "MEMOAR_CONFIG_DAMAGED");
}

/// And `login`, the command that fixes it, refused to run over it.
#[test]
fn login_rewrites_a_damaged_config_and_credential() {
    let (endpoint, _requests, _server) = spawn_mock_api(4, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = fixture_paths(&temp);
    fs::create_dir_all(&paths.config_dir).unwrap();
    fs::write(paths.config_file(), "garbage{").unwrap();
    fs::write(paths.credentials_file(), "xx").unwrap();
    login(
        &LoginArgs {
            endpoint: Some(endpoint),
            email: Some("person@example.com".to_owned()),
            password: Some("correct horse battery staple".to_owned()),
            token: None,
            machine_id: None,
            redact_secrets: false,
            redact_email_addresses: false,
            redact_home_paths: false,
        },
        &paths,
    )
    .unwrap();
    assert_eq!(status(&paths).unwrap().data["initialized"], true);
}

#[test]
fn a_damaged_queue_names_the_file_to_move_aside() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");
    fs::create_dir_all(&paths.data_dir).unwrap();
    fs::write(
        paths.queue_file(),
        "not a database, only text that is long enough",
    )
    .unwrap();
    let error = sync(&one_shot(), false, &paths).unwrap_err();
    assert_eq!(error.code, "MEMOAR_QUEUE_DAMAGED");
    assert!(error.hint.contains("queue.sqlite3"), "{}", error.hint);
}

/// Two syncs on one queue both uploaded every pending artifact and both
/// declared it, and a watch started twice did that on every cycle.
#[test]
fn a_second_sync_on_the_same_queue_is_refused_while_the_first_runs() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");
    let held = acquire_sync_lock(&paths).unwrap();
    let error = sync(&one_shot(), false, &paths).unwrap_err();
    assert_eq!(error.code, "MEMOAR_LOCKED");
    assert_eq!(error.exit_code, EXIT_LOCKED);
    assert!(
        error.message.contains(&std::process::id().to_string()),
        "the message names the process holding it: {}",
        error.message
    );
    drop(held);
    // Another test thread forking a child (`hostname`, for the machine name)
    // holds a copy of every open descriptor until the child execs, the lock
    // included. So "released" is asserted with a moment to settle.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match acquire_sync_lock(&paths) {
            Ok(_) => break,
            Err(error) if std::time::Instant::now() >= deadline => {
                panic!("not released when dropped: {}", error.message)
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
}

/// The blobs are the transcripts. They sat in a directory any local user
/// could read, and so did the directory holding the credential.
#[cfg(unix)]
#[test]
fn the_queue_and_config_directories_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let (endpoint, _requests, _server) = spawn_mock_api(4, None);
    let temp = tempfile::tempdir().unwrap();
    let paths = fixture_paths(&temp);
    login(
        &LoginArgs {
            endpoint: Some(endpoint),
            email: Some("person@example.com".to_owned()),
            password: Some("correct horse battery staple".to_owned()),
            token: None,
            machine_id: None,
            redact_secrets: false,
            redact_email_addresses: false,
            redact_home_paths: false,
        },
        &paths,
    )
    .unwrap();
    for directory in [
        paths.config_dir.clone(),
        paths.data_dir.clone(),
        paths.data_dir.join("blobs"),
    ] {
        let mode = fs::metadata(&directory).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{} is {mode:o}", directory.display());
    }
}

/// Turning a source off is a local setting, and it is written before the
/// archive is told. An unreachable archive made the command fail with exit 4
/// after the change had taken effect.
#[test]
fn turning_a_source_off_works_offline_and_says_the_archive_was_not_told() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");
    let output = sources(
        &SourcesCommand::Disable {
            source: "cursor".to_owned(),
        },
        &paths,
    )
    .expect("the setting took effect, so the command succeeded");
    assert_eq!(output.data["enabled"], false);
    assert_eq!(output.data["archive"]["updated"], false);
    assert!(
        load_config(&paths)
            .unwrap()
            .disabled_sources
            .contains("cursor")
    );

    let error = sources(
        &SourcesCommand::Disable {
            source: "nope".to_owned(),
        },
        &paths,
    )
    .unwrap_err();
    assert!(error.message.contains("claude-code"), "{}", error.message);
}
