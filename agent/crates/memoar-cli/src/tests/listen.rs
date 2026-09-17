//! The command channel's idle window.

use crate::args::ListenArgs;
use crate::listen::listen;
use crate::tests::mock::configured_paths;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

fn answer_json(mut stream: TcpStream, body: serde_json::Value) {
    let body = serde_json::to_vec(&body).unwrap();
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(&body);
}

/// Serves a command stream that keeps producing past the idle window, plus the
/// token and ack calls `listen` makes around it.
///
/// Each connection gets its own thread: the stream holds one open for the
/// length of the test, and the acks arrive on others while it is sleeping.
///
/// The commands are of an unsupported kind on purpose — `listen` acks the
/// failure and carries on, which drives the loop without needing a real
/// conversion bundle on disk.
fn spawn_stream(commands: usize, gap: Duration) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(mut stream) = connection else { return };
            std::thread::spawn(move || {
                let mut head = [0_u8; 2048];
                let read = stream.read(&mut head).unwrap_or(0);
                let request = String::from_utf8_lossy(&head[..read]).into_owned();
                if request.contains("/auth/machine-token") {
                    answer_json(
                        stream,
                        json!({ "token": "machine-token", "expiresAt": "2099-01-01T00:00:00Z" }),
                    );
                    return;
                }
                if !request.contains("/commands/stream") {
                    answer_json(stream, json!({ "ok": true }));
                    return;
                }
                let _ =
                    stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n");
                for index in 0..commands {
                    std::thread::sleep(gap);
                    let event = format!(
                        "event: command\ndata: {}\n\n",
                        json!({ "id": format!("command-{index}"), "kind": "unsupported" }),
                    );
                    if stream.write_all(event.as_bytes()).is_err() {
                        return;
                    }
                    let _ = stream.flush();
                }
                // Then go quiet. The client is reading, so it notices the
                // window has passed on its next pass around the loop.
                std::thread::sleep(gap);
            });
        }
    });
    endpoint
}

/// A machine that keeps being given work is not idle.
///
/// The deadline was computed once before the loop and never moved, so the
/// window measured total connected time instead. A machine receiving a command
/// every second was still cut off at the deadline set when it connected — the
/// opposite of what `--idle-timeout-seconds` promises, and worst for the
/// machine doing the most work.
///
/// The window is checked between reads, which is what makes this observable:
/// each command wakes the loop, and the check at the top decides whether there
/// is another pass.
#[test]
fn work_arriving_keeps_the_stream_open_past_the_first_window() {
    let gap = Duration::from_millis(600);
    // Commands land at 0.6s, 1.2s and 1.8s. All three are outside a one-second
    // window measured from the connection, and inside one that each command
    // renews.
    let endpoint = spawn_stream(3, gap);
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);

    let started = Instant::now();
    let output = listen(
        &ListenArgs {
            idle_timeout_seconds: 1,
            max_commands: 0,
        },
        &paths,
    )
    .expect("the stream ends by going quiet, not by failing");
    let handled = output.data["handled"].as_array().expect("handled commands");

    assert_eq!(
        handled.len(),
        3,
        "a command arriving inside a renewed window should be handled; took {:?}",
        started.elapsed(),
    );
}

/// One command a machine cannot apply must not end the channel.
///
/// The failure was acked — which is the whole point of acking a failure, so an
/// operator can see why — and then returned as an error, which ended the
/// listener. A single unsupported kind, or one bundle that would not
/// materialize, and the machine went deaf to everything after it.
#[test]
fn a_command_that_cannot_be_applied_does_not_end_the_channel() {
    let gap = Duration::from_millis(300);
    let endpoint = spawn_stream(3, gap);
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);

    let output = listen(
        &ListenArgs {
            idle_timeout_seconds: 2,
            max_commands: 0,
        },
        &paths,
    )
    .expect("an unapplicable command is reported, not fatal");
    let handled = output.data["handled"].as_array().expect("handled commands");

    assert_eq!(handled.len(), 3, "every command should be accounted for");
    for (index, entry) in handled.iter().enumerate() {
        assert_eq!(entry["id"], format!("command-{index}"));
        assert_eq!(
            entry["status"], "failed",
            "the outcome is reported as it was"
        );
        assert!(
            entry["error"]
                .as_str()
                .unwrap_or_default()
                .contains("unsupported"),
            "and says why: {entry}",
        );
    }
}
