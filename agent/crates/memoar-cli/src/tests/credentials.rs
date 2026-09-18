use memoar_daemon::RedactionConfig;
use std::collections::BTreeSet;
use std::fs;

use super::mock::fixture_paths;
use crate::config::{Config, load_credential, save_config};
// Only the two mode tests below use this, and a file mode is a unix idea, so on
// Windows the import is dead and `-D warnings` says so.
#[cfg(unix)]
use crate::config::create_private;
use crate::credential::{Credential, CredentialStore};

#[test]
fn credentials_are_separate_and_mode_is_private() {
    let temp = tempfile::tempdir().unwrap();
    let paths = fixture_paths(&temp);
    fs::create_dir_all(&paths.home).unwrap();
    let config = Config {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        endpoint: "http://127.0.0.1:4000/v1".to_owned(),
        machine_id: "0198d8d0-977c-777b-9f8f-0f6d8416e700".to_owned(),
        disabled_sources: BTreeSet::new(),
        redaction: RedactionConfig::disabled(),
    };
    save_config(&paths, &config).unwrap();
    paths
        .credential_store()
        .store(&Credential::Bearer("secret-user-token".to_owned()))
        .unwrap();
    let config_text = fs::read_to_string(paths.config_file()).unwrap();
    assert!(!config_text.contains("secret-user-token"));
    assert_eq!(
        load_credential(&paths).unwrap(),
        Credential::Bearer("secret-user-token".to_owned())
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(paths.credentials_file())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[cfg(unix)]
#[test]
fn a_credential_file_is_never_briefly_world_readable() {
    // The test below this one checks the mode of the finished file, which
    // stayed green while the token was written into a temporary opened at
    // the default umask and only tightened afterwards. What matters is the
    // mode the file has the instant it exists, so that is what is asserted.
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("secret");
    let file = create_private(&path, 0o600).unwrap();
    let mode = file.metadata().unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o600,
        "the file was readable by others before anything was written to it"
    );
    drop(file);
}

#[cfg(unix)]
#[test]
fn no_temporary_file_survives_a_credential_write() {
    // A leftover .memoar-*.tmp would hold the token under whatever mode it
    // was created with, outliving the window entirely.
    let temp = tempfile::tempdir().unwrap();
    let paths = fixture_paths(&temp);
    paths
        .credential_store()
        .store(&Credential::Bearer("secret-user-token".to_owned()))
        .unwrap();
    let parent = paths.credentials_file().parent().unwrap().to_owned();
    let leftovers: Vec<_> = fs::read_dir(&parent)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".memoar-") && name.ends_with(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "temporary credential files were left behind: {leftovers:?}"
    );
}
