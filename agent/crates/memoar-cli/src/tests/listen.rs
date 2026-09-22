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
    spawn_frames(
        (0..commands)
            .map(|index| {
                json!({ "id": format!("command-{index}"), "kind": "unsupported" }).to_string()
            })
            .collect(),
        gap,
    )
}

/// The same stream, but with the `data:` payloads written verbatim, so a test
/// can send something this client cannot read.
fn spawn_frames(frames: Vec<String>, gap: Duration) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(mut stream) = connection else { return };
            let frames = frames.clone();
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
                for frame in &frames {
                    std::thread::sleep(gap);
                    let event = format!("event: command\ndata: {frame}\n\n");
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

/// Nor must a command this client cannot even read.
///
/// The fix above covered the command that was applied and failed. Two paths
/// upstream of it still propagated: a `data:` payload that is not JSON, and a
/// command with no `id` — which cannot be acked, because there is no
/// acknowledgement URL to ack it at. Either one ended the listener, so a
/// single malformed row in the archive's command table made this machine deaf
/// to everything queued behind it, with nothing on the terminal saying which
/// row.
///
/// The third command is the assertion that matters: it can only be in the
/// report if the listener was still reading after the first two.
#[test]
fn a_command_that_cannot_be_read_does_not_end_the_channel() {
    let endpoint = spawn_frames(
        vec![
            "not json at all".to_owned(),
            json!({ "kind": "materialize" }).to_string(),
            json!({ "id": "command-2", "kind": "unsupported" }).to_string(),
        ],
        Duration::from_millis(200),
    );
    let temp = tempfile::tempdir().unwrap();
    let paths = configured_paths(&temp, &endpoint);

    let output = listen(
        &ListenArgs {
            idle_timeout_seconds: 2,
            max_commands: 0,
        },
        &paths,
    )
    .expect("an unreadable command is reported, not fatal");
    let handled = output.data["handled"].as_array().expect("handled commands");

    assert_eq!(
        handled.len(),
        3,
        "every frame is accounted for: {handled:?}"
    );
    assert!(
        handled[0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("was not JSON"),
        "the unparseable frame says what was wrong: {}",
        handled[0]
    );
    assert!(
        handled[1]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("did not include an id"),
        "and so does the unackable one: {}",
        handled[1]
    );
    assert_eq!(
        handled[2]["id"], "command-2",
        "the listener was still reading after both"
    );
    assert_eq!(output.data["applied"], 0);
    assert_eq!(output.data["failed"], 3, "counted, not derived");
    assert!(
        !output.data["stoppedBecause"]
            .as_str()
            .unwrap_or_default()
            .is_empty(),
        "and says why it stopped rather than leaving it to be inferred: {}",
        output.data
    );
}
