use crate::api::{problem_message, status_sentence};
use crate::sse::SseDecoder;

/// A rejected request used to print the whole problem document at the
/// terminal, wire format and all.
#[test]
fn a_refusal_reads_as_a_sentence() {
    let body = r#"{"type":"https://memoar.dev/problems/unauthorized","title":"Unauthorized","status":401,"code":"unauthorized","detail":"Valid bearer, machine, or API-key credentials are required","requestId":"fd492b99"}"#;

    let message = problem_message(401, body);

    assert_eq!(
        message,
        "Valid bearer, machine, or API-key credentials are required (HTTP 401)"
    );
    assert!(!message.contains('{'), "no wire format reaches the reader");
    assert!(!message.contains("memoar.dev/problems"));
}

#[test]
fn a_title_stands_in_when_there_is_no_detail() {
    let message = problem_message(409, r#"{"title":"Email already registered","status":409}"#);
    assert_eq!(message, "Email already registered (HTTP 409)");
}

#[test]
fn a_body_that_is_not_a_problem_document_says_something_useful() {
    // A proxy answering instead of the archive: an HTML error page dumped
    // on the terminal is worse than a sentence about the status.
    let message = problem_message(502, "<html><body>502 Bad Gateway</body></html>");
    assert_eq!(
        message,
        "The archive is having trouble. Retry shortly. (HTTP 502)"
    );
    assert!(!message.contains("<html>"));
}

#[test]
fn an_unsigned_machine_is_told_what_to_run() {
    assert!(status_sentence(401).contains("memoar login"));
}

#[test]
fn sse_decoder_yields_complete_events_only() {
    let mut decoder = SseDecoder::new();
    // A frame split across reads must not surface until it is complete.
    assert!(
        decoder
            .push("event: command\ndata: {\"id\":\"a\"")
            .is_empty()
    );
    let events = decoder.push("}\n\n");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event, "command");
    assert_eq!(events[0].data, "{\"id\":\"a\"}");
}

#[test]
fn sse_decoder_handles_several_frames_in_one_chunk() {
    let mut decoder = SseDecoder::new();
    let events = decoder.push("event: ping\ndata: 1\n\nevent: command\ndata: {}\n\n");
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].event, "ping");
    assert_eq!(events[1].event, "command");
}

#[test]
fn sse_decoder_ignores_comments_and_dataless_frames() {
    let mut decoder = SseDecoder::new();
    assert!(decoder.push(": keep-alive\n\n").is_empty());
    assert!(decoder.push("event: command\n\n").is_empty());
}

#[test]
fn sse_decoder_joins_multi_line_data_and_defaults_the_event_name() {
    let mut decoder = SseDecoder::new();
    let events = decoder.push("data: first\ndata: second\n\n");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event, "message");
    assert_eq!(events[0].data, "first\nsecond");
}
