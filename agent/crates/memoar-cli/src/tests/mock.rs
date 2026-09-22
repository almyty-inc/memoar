use memoar_daemon::RedactionConfig;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::time::Duration;

use crate::config::{Config, RuntimePaths, save_config};
use crate::credential::{Credential, CredentialStore};

pub(crate) fn fixture_paths(temp: &tempfile::TempDir) -> RuntimePaths {
    RuntimePaths {
        config_dir: temp.path().join("config"),
        data_dir: temp.path().join("data"),
        home: temp.path().join("fixture-home"),
    }
}

pub(crate) const MACHINE_ID: &str = "0198d8d0-977c-777b-9f8f-0f6d8416e700";
pub(crate) const INSTALLATION_ID: &str = "0198d8d0-977c-777b-9f8f-0f6d8416e701";
/// A machine id the mock archive does not list: what a config left pointing at
/// a machine somebody deleted, or at another archive's machine, looks like.
pub(crate) const RETIRED_MACHINE_ID: &str = "0198d8d0-977c-777b-9f8f-0f6d8416e702";

#[derive(Debug, Clone)]
pub(crate) struct RecordedRequest {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: String,
    pub(crate) body: Vec<u8>,
}

/// What the mock archive does before it answers.
#[derive(Default)]
pub(crate) struct MockOptions {
    pub(crate) request_count: usize,
    pub(crate) conversion_bundle: Option<Value>,
    pub(crate) workspace: String,
    /// Connections accepted and dropped without a reply, before any request
    /// is answered: what a closed lid or a changed network looks like from
    /// the client's side.
    pub(crate) dropped_connections: usize,
    /// A path substring whose response is held back, and for how long, so a
    /// test can find out which timeout a request was given.
    pub(crate) slow_path: &'static str,
    pub(crate) slow_by: Duration,
}

pub(crate) fn spawn_mock_api(
    request_count: usize,
    conversion_bundle: Option<Value>,
) -> (
    String,
    std::sync::Arc<std::sync::Mutex<Vec<RecordedRequest>>>,
    std::thread::JoinHandle<()>,
) {
    spawn_mock_api_with_workspace(request_count, conversion_bundle, String::new())
}

/// `workspace` is the project root the mock claims to have sessions in, so a
/// test can put memory files there and watch them being captured.
pub(crate) fn spawn_mock_api_with_workspace(
    request_count: usize,
    conversion_bundle: Option<Value>,
    workspace: String,
) -> (
    String,
    std::sync::Arc<std::sync::Mutex<Vec<RecordedRequest>>>,
    std::thread::JoinHandle<()>,
) {
    spawn_mock(MockOptions {
        request_count,
        conversion_bundle,
        workspace,
        ..MockOptions::default()
    })
}

pub(crate) fn spawn_mock(
    options: MockOptions,
) -> (
    String,
    std::sync::Arc<std::sync::Mutex<Vec<RecordedRequest>>>,
    std::thread::JoinHandle<()>,
) {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    let MockOptions {
        request_count,
        conversion_bundle,
        workspace,
        dropped_connections,
        slow_path,
        slow_by,
    } = options;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let handle = std::thread::spawn(move || {
        // Accepted and hung up on: the client sees a transport failure with
        // no HTTP status to interpret, which is the case the watcher used to
        // die on.
        for _ in 0..dropped_connections {
            drop(listener.accept().unwrap());
        }
        for _ in 0..request_count {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            let header_end = loop {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0, "client closed before HTTP headers");
                bytes.extend_from_slice(&buffer[..read]);
                if let Some(position) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::trim)
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap_or(0);
            while bytes.len() < header_end + content_length {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0, "client closed before HTTP body");
                bytes.extend_from_slice(&buffer[..read]);
            }
            let request_line = headers.lines().next().unwrap();
            let mut parts = request_line.split_whitespace();
            let method = parts.next().unwrap().to_owned();
            let path = parts.next().unwrap().to_owned();
            let body = bytes[header_end..header_end + content_length].to_vec();
            recorded.lock().unwrap().push(RecordedRequest {
                method: method.clone(),
                path: path.clone(),
                headers: headers.clone(),
                body: body.clone(),
            });

            let (status, response) = match (method.as_str(), path.as_str()) {
                ("POST", "/v1/auth/login") => (200, json!({"accessToken": "user-token"})),
                ("POST", "/v1/machines") => (201, json!({"id": MACHINE_ID})),
                ("PATCH", path) if path.starts_with("/v1/machines/") => (200, json!({})),
                ("GET", "/v1/machines") => (200, json!({"items": [{"id": MACHINE_ID}]})),
                ("POST", "/v1/auth/api-keys") => (
                    201,
                    json!({"apiKey": {"id": "key-1"}, "secret": "memoar_test-capture-key"}),
                ),
                ("POST", "/v1/auth/machine-token") => (
                    201,
                    json!({"token": "machine-token", "expiresAt": "2099-01-01T00:00:00Z"}),
                ),
                ("POST", "/v1/ingest/delta") => {
                    let request: Value = serde_json::from_slice(&body).unwrap();
                    (200, json!({"missing": request["hashes"]}))
                }
                ("PUT", path) if path.starts_with("/v1/ingest/artifacts/") => (201, json!({})),
                ("POST", "/v1/ingest/manifests") => {
                    let request: Value = serde_json::from_slice(&body).unwrap();
                    (
                        202,
                        json!({
                            "batchId": request["batchId"],
                            "accepted": request["artifacts"].as_array().unwrap().len(),
                            "duplicate": 0,
                            "queuedAt": "2026-08-18T00:00:00Z"
                        }),
                    )
                }
                ("GET", path) if path.starts_with("/v1/search?") => {
                    (200, json!({"items": [], "nextCursor": null}))
                }
                ("GET", path) if path.starts_with("/v1/sessions/") => {
                    (200, json!({"session": {"id": "session"}, "turns": []}))
                }
                // The workspaces this account has archived sessions in, which
                // is how the agent knows which directories are projects.
                ("GET", path) if path.starts_with("/v1/sessions") => (
                    200,
                    json!({"items": [{"id": "session", "workspace": workspace.clone()}]}),
                ),
                ("POST", "/v1/memory") => (
                    200,
                    json!({"document": {"id": MACHINE_ID}, "revision": {"id": MACHINE_ID}}),
                ),
                // An archive that parsed everything it was sent. Serving this
                // is what makes a healthy archive distinguishable from one
                // that never answered — `doctor` used to report the same
                // green for both.
                ("GET", "/v1/ingest/unparsed") => (200, json!({"items": []})),
                ("POST", "/v1/pack") => (202, json!({"id": "pack-job"})),
                ("POST", "/v1/convert") => (
                    202,
                    json!({
                        "id": "conversion-job",
                        "status": "ready",
                        "sessionId": MACHINE_ID,
                        "target": "claude-code"
                    }),
                ),
                ("GET", "/v1/convert/conversion-job/download") => (
                    200,
                    conversion_bundle
                        .clone()
                        .expect("bundle response configured"),
                ),
                other => panic!("unexpected mock request: {other:?}"),
            };
            let response = serde_json::to_vec(&response).unwrap();
            if !slow_path.is_empty() && path.contains(slow_path) {
                std::thread::sleep(slow_by);
            }
            // Writing is allowed to fail: a test that deliberately times a
            // request out has already closed this socket, and that is the
            // test passing, not the mock breaking.
            let _ = write!(
                stream,
                "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                response.len()
            );
            let _ = stream.write_all(&response);
        }
    });
    (endpoint, requests, handle)
}

pub(crate) fn configured_paths(temp: &tempfile::TempDir, endpoint: &str) -> RuntimePaths {
    let paths = fixture_paths(temp);
    fs::create_dir_all(&paths.home).unwrap();
    save_config(
        &paths,
        &Config {
            contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
            endpoint: endpoint.to_owned(),
            machine_id: MACHINE_ID.to_owned(),
            installation_id: INSTALLATION_ID.to_owned(),
            disabled_sources: BTreeSet::new(),
            redaction: RedactionConfig::disabled(),
        },
    )
    .unwrap();
    paths
        .credential_store()
        .store(&Credential::Bearer("user-token".to_owned()))
        .unwrap();
    paths
}
