//! Requests run against a stand-in archive, the cache, and the refusals.

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use super::fixtures::{FIRST, page};
use crate::error::EXIT_USAGE;
use crate::tests::mock::{configured_paths, fixture_paths};
use crate::tui::app::{App, is_offline};
use crate::tui::request::{Request, Response};
use crate::tui::{cache, export::export, launch, start, worker};

/// Answers each request with `body`, and records the request lines.
fn archive(body: Value, requests: usize) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&seen);
    std::thread::spawn(move || {
        for _ in 0..requests {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut head = [0_u8; 8192];
            let read = stream.read(&mut head).unwrap_or(0);
            let text = String::from_utf8_lossy(&head[..read]);
            record
                .lock()
                .unwrap()
                .push(text.lines().next().unwrap_or_default().to_owned());
            let bytes = serde_json::to_vec(&body).unwrap();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                bytes.len()
            );
            let _ = stream.write_all(&bytes);
        }
    });
    (endpoint, seen)
}

#[test]
fn the_session_list_is_fetched_cached_and_shown_from_the_cache() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, seen) = archive(page(), 1);
    let paths = configured_paths(&temp, &endpoint);
    let Response::Sessions { result, .. } = worker::run(Request::Sessions { cursor: None }, &paths)
    else {
        panic!("wrong response");
    };
    assert_eq!(result.unwrap()["total"], 3);
    assert!(seen.lock().unwrap()[0].starts_with("GET /v1/sessions?limit=100 "));
    let (cached, _) = cache::load_sessions(&paths).unwrap();
    assert_eq!(cached, page());
    let mut app = App::new(endpoint);
    let first = start(&mut app, &paths);
    assert_eq!(app.sessions.rows.len(), 3);
    assert!(app.sessions.cached_at.is_some());
    assert!(
        app.sessions.loading,
        "the cache is shown while the archive is asked"
    );
    assert_eq!(first[0], Request::Sessions { cursor: None });
}

#[test]
fn a_cache_from_another_sign_in_is_not_shown() {
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, "http://127.0.0.1:9/v1");
    cache::save_sessions(&paths, &page());
    let other = configured_paths(&temp, "http://127.0.0.1:10/v1");
    assert!(cache::load_sessions(&other).is_none());
}

#[test]
fn export_writes_a_file_and_never_overwrites_one() {
    let temp = tempfile::tempdir().unwrap();
    let bundle = json!({ "memoarBundle": "1", "sessions": [] });
    let (endpoint, seen) = archive(bundle.clone(), 2);
    let paths = configured_paths(&temp, &endpoint);
    let out = temp.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    let written = export(&paths, FIRST, &out).unwrap();
    assert_eq!(
        written.file_name().unwrap().to_string_lossy(),
        format!("memoar-{FIRST}.json")
    );
    let saved: Value = serde_json::from_slice(&std::fs::read(&written).unwrap()).unwrap();
    assert_eq!(saved, bundle);
    assert!(
        seen.lock().unwrap()[0].contains(&format!("/v1/sessions/{FIRST}/export?format=canonical"))
    );
    std::fs::write(&written, b"kept").unwrap();
    let refused = export(&paths, FIRST, &out).unwrap_err();
    assert!(
        refused.message.contains("already in"),
        "{}",
        refused.message
    );
    assert_eq!(std::fs::read(&written).unwrap(), b"kept");
    assert!(export(&paths, "../escape", &out).is_err());
}

#[test]
fn an_archive_that_does_not_answer_is_offline() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    drop(listener);
    let paths = configured_paths(&temp, &endpoint);
    let Response::Sessions { result, .. } = worker::run(Request::Sessions { cursor: None }, &paths)
    else {
        panic!("wrong response");
    };
    assert!(is_offline(&result.unwrap_err()));
}

#[test]
fn not_signed_in_says_to_run_login() {
    let temp = tempfile::tempdir().unwrap();
    let paths = fixture_paths(&temp);
    let Response::Sessions { result, .. } = worker::run(Request::Sessions { cursor: None }, &paths)
    else {
        panic!("wrong response");
    };
    assert!(result.unwrap_err().hint.contains("memoar login"));
}

#[test]
fn json_mode_is_refused_with_a_usage_error() {
    let temp = tempfile::tempdir().unwrap();
    let error = launch(true, &fixture_paths(&temp)).unwrap_err();
    assert_eq!(error.exit_code, EXIT_USAGE);
    assert!(error.message.contains("interactive"));
}

#[test]
fn the_clipboard_sequence_is_osc_52() {
    assert_eq!(crate::tui::clipboard::osc52("id"), "\x1b]52;c;aWQ=\x07");
}
