//! `memoar mcp` relays stdio JSON-RPC to the archive's `/mcp` and back.

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::api::ApiClient;
use crate::credential::Credential;
use crate::mcp::{McpProxy, mcp_url, serve_streams};

/// What the fake archive answers each POST with, in order.
struct Reply {
    status: u16,
    content_type: &'static str,
    body: String,
}

fn json_reply(body: &Value) -> Reply {
    Reply {
        status: 200,
        content_type: "application/json",
        body: body.to_string(),
    }
}

/// Each request's lowercased headers and its body.
type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// A one-thread HTTP server that answers `replies` in order and records each
/// request's headers and body.
fn spawn(replies: Vec<Reply>) -> (String, Seen, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    let handle = std::thread::spawn(move || {
        for reply in replies {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            let end = loop {
                let read = stream.read(&mut buffer).unwrap();
                bytes.extend_from_slice(&buffer[..read]);
                if let Some(at) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    break at + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
            let length: usize = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .map_or(0, |value| value.trim().parse().unwrap());
            while bytes.len() < end + length {
                let read = stream.read(&mut buffer).unwrap();
                bytes.extend_from_slice(&buffer[..read]);
            }
            let body = String::from_utf8_lossy(&bytes[end..end + length]).into_owned();
            recorded.lock().unwrap().push((headers, body));
            let response = format!(
                "HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                reply.status,
                reply.content_type,
                reply.body.len(),
                reply.body
            );
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    (url, seen, handle)
}

fn proxy(url: &str) -> McpProxy {
    let credential = Credential::ApiKey("memoar_test_key".to_owned());
    McpProxy::new(
        ApiClient::new("http://unused/v1", Some(&credential)),
        url.to_owned(),
    )
}

fn relay(proxy: &mut McpProxy, lines: &[&str]) -> Vec<Value> {
    let mut output = Vec::new();
    serve_streams(proxy, lines.join("\n").as_bytes(), &mut output).unwrap();
    String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn the_endpoint_is_outside_the_api_prefix() {
    assert_eq!(
        mcp_url("https://api.example.test/v1"),
        "https://api.example.test/mcp"
    );
    assert_eq!(
        mcp_url("https://api.example.test/v1/"),
        "https://api.example.test/mcp"
    );
    assert_eq!(
        mcp_url("http://localhost:4000"),
        "http://localhost:4000/mcp"
    );
}

#[test]
fn relays_requests_notifications_and_event_streams() {
    let initialized =
        json!({"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18","capabilities":{}}});
    let listed = json!({"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"search_sessions"}]}});
    let (url, seen, server) = spawn(vec![
        json_reply(&initialized),
        Reply {
            status: 202,
            content_type: "text/plain",
            body: String::new(),
        },
        Reply {
            status: 200,
            content_type: "text/event-stream",
            body: format!("event: message\ndata: {listed}\n\n"),
        },
    ]);
    let mut proxy = proxy(&url);
    let replies = relay(
        &mut proxy,
        &[
            r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "",
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        ],
    );
    server.join().unwrap();
    assert_eq!(
        replies,
        vec![initialized, listed],
        "a notification is owed no reply"
    );

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 3, "the blank line is not a message");
    for (headers, _) in seen.iter() {
        assert!(headers.contains("x-memoar-key: memoar_test_key"));
        assert!(headers.contains("accept: application/json, text/event-stream"));
    }
    assert!(!seen[0].0.contains("mcp-protocol-version"));
    assert!(seen[2].0.contains("mcp-protocol-version: 2025-06-18"));
    assert!(seen[1].1.contains("notifications/initialized"));
}

#[test]
fn a_key_without_mcp_use_is_told_to_log_in_again() {
    let (url, _, server) = spawn(vec![Reply {
        status: 403,
        content_type: "application/json",
        body: json!({"statusCode":403,"message":"Missing required scope: mcp:use"}).to_string(),
    }]);
    let mut proxy = proxy(&url);
    let replies = relay(
        &mut proxy,
        &[r#"{"jsonrpc":"2.0","id":"a","method":"tools/list"}"#],
    );
    server.join().unwrap();
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["id"], "a");
    assert_eq!(replies[0]["error"]["code"], -32000);
    let message = replies[0]["error"]["message"].as_str().unwrap();
    assert!(message.contains("mcp:use"), "{message}");
    assert!(message.contains("memoar login"), "{message}");
}

#[test]
fn a_line_that_is_not_json_gets_a_parse_error() {
    let mut proxy = proxy("http://127.0.0.1:1/mcp");
    let replies = relay(&mut proxy, &["{nope"]);
    assert_eq!(replies[0]["error"]["code"], -32700);
    assert_eq!(replies[0]["id"], Value::Null);
}

#[test]
fn an_unreachable_archive_answers_each_request_in_a_batch() {
    let mut proxy = proxy("http://127.0.0.1:1/mcp");
    let replies = relay(
        &mut proxy,
        &[
            r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/x"},{"jsonrpc":"2.0","id":2,"method":"ping"}]"#,
        ],
    );
    let ids: Vec<_> = replies.iter().map(|reply| reply["id"].clone()).collect();
    assert_eq!(ids, vec![json!(1), json!(2)]);
}

#[test]
fn a_tool_error_is_a_refusal_and_structured_content_is_the_data() {
    let refused =
        json!({"content":[{"type":"text","text":"invalid_arguments:sessionId"}],"isError":true});
    let error = crate::mcp::tool_result("get_excerpt", &refused).unwrap_err();
    assert_eq!(error.code, "MEMOAR_TOOL_ERROR");
    assert!(error.message.contains("invalid_arguments:sessionId"));
    let answered = json!({"content":[{"type":"text","text":"{}"}],"structuredContent":{"items":[]},"isError":false});
    assert_eq!(
        crate::mcp::tool_result("search_sessions", &answered).unwrap(),
        json!({"items":[]})
    );
}
