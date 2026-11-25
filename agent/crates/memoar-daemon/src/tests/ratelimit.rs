use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use crate::error::DaemonError;
use crate::manifest::SyncTransport;
use crate::queue::{QueueStatus, QueuedArtifact};
use crate::transport::HttpTransport;

/// Answers `refusals` uploads with 429 and `Retry-After`, then 201, and
/// records each request's body length.
fn spawn_rate_limited(refusals: usize, retry_after: u64) -> (String, Arc<Mutex<Vec<usize>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let seen = bodies.clone();
    std::thread::spawn(move || {
        for (index, connection) in listener.incoming().enumerate() {
            let Ok(mut stream) = connection else { return };
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            let (header_end, length) = loop {
                let read = stream.read(&mut buffer).unwrap_or(0);
                if read == 0 {
                    return;
                }
                bytes.extend_from_slice(&buffer[..read]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    break (end + 4, length);
                }
            };
            while bytes.len() < header_end + length {
                let read = stream.read(&mut buffer).unwrap_or(0);
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..read]);
            }
            seen.lock().unwrap().push(bytes.len() - header_end);
            let reply = if index < refusals {
                format!(
                    "HTTP/1.1 429 Too Many Requests\r\nretry-after: {retry_after}\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}"
                )
            } else {
                "HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}".to_owned()
            };
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    (endpoint, bodies)
}

fn artifact() -> QueuedArtifact {
    QueuedArtifact {
        sha256: "a".repeat(64),
        size: 11,
        source: "claude-code".to_owned(),
        source_path: "/home/me/.claude/projects/p/s.jsonl".to_owned(),
        local_path: "unused".into(),
        modified_at: "2026-11-24T00:00:00Z".to_owned(),
        status: QueueStatus::Pending,
        attempts: 0,
        last_error: None,
        redacted: false,
        redaction_count: 0,
    }
}

/// The archive allows 300 requests a minute per route, and a first sync of a
/// well-used laptop is more uploads than that. Each 429 was charged to its
/// artifact as a failure. The archive says how long to wait, and the same
/// upload, body and all, goes again after that.
#[test]
fn an_upload_waits_out_a_rate_limit_and_is_sent_again_whole() {
    let (endpoint, bodies) = spawn_rate_limited(2, 1);
    let transport = HttpTransport::new(endpoint, "token").without_pauses();
    transport
        .upload(&artifact(), b"hello world".to_vec())
        .expect("the third attempt is accepted");
    assert_eq!(*bodies.lock().unwrap(), vec![11, 11, 11]);
}

/// Patience has an end, and what is left is reported as the 429 it is, which
/// stops the pass without charging any artifact for it.
#[test]
fn a_rate_limit_that_does_not_lift_is_reported() {
    let (endpoint, bodies) = spawn_rate_limited(usize::MAX, 120);
    let transport = HttpTransport::new(endpoint, "token").without_pauses();
    let error = transport
        .upload(&artifact(), b"hello world".to_vec())
        .unwrap_err();
    assert!(
        matches!(error, DaemonError::Http { status: 429, .. }),
        "{error}"
    );
    assert!(error.is_pass_wide());
    assert_eq!(
        bodies.lock().unwrap().len(),
        3,
        "120s, 120s, then over 300s"
    );
}
