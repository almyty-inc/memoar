//! A synthetic store of fifteen hundred sessions through plan, a bounded first
//! sync and a full one, against a mock archive. Nothing is copied into the
//! data directory, and nothing older than the window goes up unasked.

use serde_json::Value;
use std::fs::{self, File};
use std::path::Path;
use std::time::{Duration, SystemTime};

use super::mock::{configured_paths, spawn_mock_api};
use crate::args::SyncArgs;
use crate::config::{RuntimePaths, load_config, save_config};
use crate::error::EXIT_DISK_LOW;
use crate::sync::sync;

const RECENT: usize = 1200;
const OLD: usize = 300;

fn store(home: &Path) {
    for index in 0..RECENT + OLD {
        let workspace = format!("/work/project-{}", index % 12);
        let dir = home
            .join(".claude/projects")
            .join(workspace.replace('/', "-"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("session-{index}.jsonl"));
        fs::write(
            &path,
            format!("{{\"cwd\":\"{workspace}\",\"uuid\":\"{index}\",\"message\":\"turn\"}}\n"),
        )
        .unwrap();
        if index >= RECENT {
            let old = SystemTime::now() - Duration::from_secs(100 * 86_400);
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
    }
}

/// Requests one drain of `uploads` makes against the mock: the machine update
/// and token, a delta and a manifest per pass of 256, every upload, and the
/// session list the memory sweep asks for.
fn requests_for(uploads: usize) -> usize {
    2 + uploads.div_ceil(256) * 2 + uploads + 1
}

fn fast(since: Option<&str>) -> SyncArgs {
    SyncArgs {
        since: since.map(str::to_owned),
        uploads_per_minute: 0,
        ..SyncArgs::default()
    }
}

fn dir_bytes(path: &Path) -> u64 {
    fs::read_dir(path)
        .unwrap()
        .flatten()
        .map(|entry| {
            let metadata = entry.metadata().unwrap();
            if metadata.is_dir() {
                dir_bytes(&entry.path())
            } else {
                metadata.len()
            }
        })
        .sum()
}

fn run(paths: &RuntimePaths, since: Option<&str>, uploads: usize) -> Value {
    let (endpoint, _, server) = spawn_mock_api(requests_for(uploads), None);
    let mut config = load_config(paths).unwrap();
    config.endpoint = endpoint;
    save_config(paths, &config).unwrap();
    let output = sync(&fast(since), false, paths).unwrap();
    server.join().unwrap();
    output.data
}

#[test]
fn a_large_store_is_planned_then_taken_in_its_window_then_in_full() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");
    store(&paths.home);

    let plan = sync(
        &SyncArgs {
            plan: true,
            ..SyncArgs::default()
        },
        true,
        &paths,
    )
    .unwrap()
    .data;
    let totals = &plan["plan"]["totals"];
    assert_eq!(totals["found"]["files"], (RECENT + OLD) as u64);
    assert_eq!(totals["toCapture"]["files"], RECENT as u64);
    assert_eq!(totals["tooOld"]["files"], OLD as u64);
    assert_eq!(
        plan["plan"]["sources"][0]["projects"]
            .as_array()
            .unwrap()
            .len(),
        12
    );
    assert!(!paths.queue_file().exists(), "a plan creates no queue");

    let first = run(&paths, None, RECENT);
    assert_eq!(first["captured"], RECENT as u64);
    assert_eq!(first["sync"]["uploaded"], RECENT as u64);
    assert_eq!(first["backfill"]["origin"], "default");
    assert_eq!(first["backfill"]["olderSkipped"]["files"], OLD as u64);
    assert!(
        first["backfill"]["hint"]
            .as_str()
            .unwrap()
            .contains("--since all")
    );

    let full = run(&paths, Some("all"), OLD);
    assert_eq!(full["captured"], OLD as u64);
    assert_eq!(full["backfill"]["unchanged"], RECENT as u64);
    assert_eq!(full["sync"]["uploaded"], OLD as u64);

    let blobs = paths.data_dir.join("blobs");
    assert_eq!(fs::read_dir(&blobs).unwrap().count(), 0, "no copies kept");
    let used = dir_bytes(&paths.data_dir);
    assert!(
        used < 4 * 1024 * 1024,
        "the data directory holds {used} bytes"
    );
}

#[test]
fn capture_below_the_free_space_floor_is_refused_with_its_own_exit_code() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");
    store(&paths.home);
    let mut config = load_config(&paths).unwrap();
    config.capture.min_free_bytes = Some(u64::MAX / 4);
    save_config(&paths, &config).unwrap();

    let error = sync(&fast(None), true, &paths).unwrap_err();
    assert_eq!(error.code, "MEMOAR_DISK_LOW");
    assert_eq!(error.exit_code, EXIT_DISK_LOW);
    assert!(
        error.retryable,
        "a service waits for space rather than stopping"
    );
    assert!(
        !paths.queue_file().exists(),
        "nothing was written to the data directory"
    );
}

#[test]
fn a_full_disk_still_uploads_what_was_queued_before_it_filled() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");
    let session = paths.home.join(".claude/projects/-work/one.jsonl");
    fs::create_dir_all(session.parent().unwrap()).unwrap();
    fs::write(&session, "{\"cwd\":\"/work\"}\n").unwrap();
    memoar_daemon::OfflineQueue::open(&paths.queue_file())
        .unwrap()
        .enqueue("claude-code", &session)
        .unwrap();
    let (endpoint, _, server) = spawn_mock_api(requests_for(1), None);
    let mut config = load_config(&paths).unwrap();
    config.endpoint = endpoint;
    config.capture.min_free_bytes = Some(u64::MAX / 4);
    save_config(&paths, &config).unwrap();

    let error = sync(&fast(None), true, &paths).unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, "MEMOAR_DISK_LOW");
    let queue = memoar_daemon::OfflineQueue::open(&paths.queue_file()).unwrap();
    assert_eq!(
        queue.counts().unwrap().synced,
        1,
        "the queued session went up"
    );
}
