//! A stand-in archive that answers the requests `memoar login` and
//! `memoar sync` make, so the desktop app can be tested end to end on any
//! runner without Docker.
//!
//! Who gets in is decided by the credentials, so one server serves every
//! scenario at once:
//!
//! - any email with [`PASSWORD`] signs in, any other password is refused (401)
//! - [`REVOKED_EMAIL`] signs in, but the key it is given is refused afterwards,
//!   as a key an operator revoked is
//! - [`API_KEY`] signs in with `--token`, any other `memoar_` key is refused
//!
//! Shared by the integration tests and `examples/stub_archive.rs`, which the
//! headless UI tests run against.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

pub const PASSWORD: &str = "correct horse battery staple";
pub const REVOKED_EMAIL: &str = "revoked@example.com";
pub const API_KEY: &str = "memoar_stub-api-key";
const REVOKED_KEY: &str = "memoar_stub-revoked";
const CAPTURE_KEY: &str = "memoar_stub-capture";
const ACCESS_TOKEN: &str = "stub-access-token";
const REVOKED_ACCESS_TOKEN: &str = "stub-access-token-revoked";

#[derive(Default)]
struct Archive {
    machines: Mutex<Vec<String>>,
    next_machine: AtomicU32,
}

struct Request {
    method: String,
    path: String,
    authorization: String,
    body: Value,
}

/// Binds `address` and serves until the process ends. Returns the endpoint.
///
/// # Panics
/// When the address cannot be bound.
pub fn serve(address: &str) -> String {
    let listener = TcpListener::bind(address).expect("bind the stub archive");
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let archive = Arc::new(Archive::default());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let archive = Arc::clone(&archive);
            std::thread::spawn(move || {
                let _ = handle(stream, &archive);
            });
        }
    });
    endpoint
}

fn handle(mut stream: TcpStream, archive: &Archive) -> std::io::Result<()> {
    let request = read_request(&mut stream)?;
    let (status, body) = answer(&request, archive);
    let body = serde_json::to_vec(&body).unwrap_or_default();
    write!(
        stream,
        "HTTP/1.1 {status} Stub\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(&body)
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();
    let mut length = 0;
    let mut authorization = String::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let lower = header.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
        if lower.starts_with("authorization:") || lower.starts_with("x-memoar-key:") {
            authorization.push_str(header);
        }
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(Request {
        method,
        path,
        authorization,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    })
}

fn problem(status: u16, detail: &str) -> (u16, Value) {
    (
        status,
        json!({ "title": "Refused", "detail": detail, "status": status }),
    )
}

fn authorized(request: &Request) -> Result<(), (u16, Value)> {
    let header = request.authorization.as_str();
    if header.contains(REVOKED_KEY) {
        return Err(problem(401, "This API key was revoked."));
    }
    let known = [ACCESS_TOKEN, REVOKED_ACCESS_TOKEN, CAPTURE_KEY, API_KEY];
    if known.iter().any(|token| header.contains(token)) {
        Ok(())
    } else {
        Err(problem(401, "Unknown credential."))
    }
}

fn sign_in(request: &Request) -> (u16, Value) {
    let email = request.body["email"].as_str().unwrap_or_default();
    if request.body["password"].as_str() != Some(PASSWORD) {
        return problem(401, "Email or password is incorrect.");
    }
    let token = if email == REVOKED_EMAIL {
        REVOKED_ACCESS_TOKEN
    } else {
        ACCESS_TOKEN
    };
    (200, json!({ "accessToken": token }))
}

fn answer(request: &Request, archive: &Archive) -> (u16, Value) {
    let route = (request.method.as_str(), request.path.as_str());
    if route == ("POST", "/v1/auth/login") {
        return sign_in(request);
    }
    if let Err(refusal) = authorized(request) {
        return refusal;
    }
    let mut machines = archive.machines.lock().unwrap();
    match route {
        ("GET", "/v1/machines") => {
            let items: Vec<Value> = machines.iter().map(|id| json!({ "id": id })).collect();
            (200, json!({ "items": items }))
        }
        ("POST", "/v1/machines") => {
            let serial = archive.next_machine.fetch_add(1, Ordering::SeqCst);
            let id = format!("0198d8d0-977c-7{serial:03x}-9f8f-0f6d8416e700");
            machines.push(id.clone());
            (201, json!({ "id": id }))
        }
        ("PATCH", path) if path.starts_with("/v1/machines/") => {
            let id = path.trim_start_matches("/v1/machines/");
            if machines.iter().any(|known| known == id) {
                (200, json!({}))
            } else {
                problem(404, "No such machine.")
            }
        }
        ("POST", "/v1/auth/api-keys") => {
            let secret = if request.authorization.contains(REVOKED_ACCESS_TOKEN) {
                REVOKED_KEY
            } else {
                CAPTURE_KEY
            };
            (
                201,
                json!({ "apiKey": { "id": "key-1" }, "secret": secret }),
            )
        }
        ("POST", "/v1/auth/machine-token") => (
            201,
            json!({ "token": CAPTURE_KEY, "expiresAt": "2099-01-01T00:00:00Z" }),
        ),
        ("POST", "/v1/ingest/delta") => (200, json!({ "missing": request.body["hashes"] })),
        ("PUT", path) if path.starts_with("/v1/ingest/artifacts/") => (201, json!({})),
        ("POST", "/v1/ingest/manifests") => {
            let accepted = request.body["artifacts"].as_array().map_or(0, Vec::len);
            (
                202,
                json!({
                    "batchId": request.body["batchId"],
                    "accepted": accepted,
                    "duplicate": 0,
                    "queuedAt": "2026-09-04T10:00:00Z"
                }),
            )
        }
        ("GET", path) if path.starts_with("/v1/sessions") => (200, json!({ "items": [] })),
        ("POST", "/v1/memory") => (200, json!({ "document": {}, "revision": {} })),
        _ => problem(404, "The stub archive does not serve this."),
    }
}
