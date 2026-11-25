//! `memoar policy`: the backfill bound, the project rules and the disk floor.

use super::mock::configured_paths;
use crate::args::PolicyArgs;
use crate::capture_policy::{parse_size, policy};
use crate::config::load_config;

#[test]
fn policy_keeps_what_it_is_given_and_reports_what_is_in_force() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");

    let shown = policy(&PolicyArgs::default(), &paths).unwrap().data;
    assert_eq!(shown["changed"], false);
    assert_eq!(shown["policy"]["origin"], "default");
    assert!(shown["policy"]["since"].is_string(), "the first-run window");
    assert!(shown["disk"]["availableBytes"].is_u64());

    let changed = policy(
        &PolicyArgs {
            since: Some("all".to_owned()),
            exclude: vec!["/private/tmp/**".to_owned(), "**/worktrees/**".to_owned()],
            min_free: Some("5GiB".to_owned()),
            ..PolicyArgs::default()
        },
        &paths,
    )
    .unwrap()
    .data;
    assert_eq!(changed["changed"], true);
    assert_eq!(changed["policy"]["origin"], "config");
    assert!(changed["policy"]["since"].is_null(), "all is no bound");
    assert_eq!(changed["minFreeBytes"], 5_u64 * 1024 * 1024 * 1024);

    policy(
        &PolicyArgs {
            remove: vec!["**/worktrees/**".to_owned()],
            since: Some("default".to_owned()),
            min_free: Some("default".to_owned()),
            ..PolicyArgs::default()
        },
        &paths,
    )
    .unwrap();
    let config = load_config(&paths).unwrap();
    assert_eq!(config.capture.exclude, vec!["/private/tmp/**".to_owned()]);
    assert_eq!(config.capture.since, None);
    assert_eq!(config.capture.min_free_bytes, None);
}

#[test]
fn policy_refuses_a_bound_or_size_it_cannot_read() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");
    let before = load_config(&paths).unwrap().capture;
    for args in [
        PolicyArgs {
            since: Some("last tuesday".to_owned()),
            ..PolicyArgs::default()
        },
        PolicyArgs {
            min_free: Some("lots".to_owned()),
            ..PolicyArgs::default()
        },
    ] {
        let error = policy(&args, &paths).unwrap_err();
        assert_eq!(error.code, "MEMOAR_USAGE");
    }
    assert!(load_config(&paths).unwrap().capture == before);
}

#[test]
fn sizes_read_decimal_and_binary_units() {
    assert_eq!(parse_size("2048").unwrap(), 2048);
    assert_eq!(parse_size("2GB").unwrap(), 2_000_000_000);
    assert_eq!(parse_size("1.5 GiB").unwrap(), 1_610_612_736);
    assert_eq!(parse_size("500m").unwrap(), 500_000_000);
    assert!(parse_size("5 parsecs").is_err());
}
