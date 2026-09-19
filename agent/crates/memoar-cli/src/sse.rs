/// One decoded Server-Sent Event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerEvent {
    pub event: String,
    pub data: String,
}

/// Incrementally decodes an SSE byte stream into events.
///
/// The server sends `event:`/`data:` pairs terminated by a blank line, plus
/// periodic `ping` events. Frames can be split across chunks, so the decoder
/// keeps a buffer between reads.
#[derive(Debug, Default)]
pub struct SseDecoder {
    buffer: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds a chunk and returns every complete event it produced.
    pub fn push(&mut self, chunk: &str) -> Vec<ServerEvent> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let frame: String = self.buffer.drain(..index + 2).collect();
            if let Some(event) = Self::decode_frame(frame.trim_end_matches('\n')) {
                events.push(event);
            }
        }
        events
    }

    fn decode_frame(frame: &str) -> Option<ServerEvent> {
        let mut event = String::from("message");
        let mut data = String::new();
        for line in frame.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                event = value.trim().to_owned();
            } else if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value.trim_start());
            }
        }
        if data.is_empty() {
            return None;
        }
        Some(ServerEvent { event, data })
    }
}
