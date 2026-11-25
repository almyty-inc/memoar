//! Waiting out a rate limit the archive announces, within one pass.
//!
//! The archive allows each route 300 requests a minute per account, and a
//! first sync on a machine with a few hundred sessions is more uploads than
//! that. Each one past the limit was answered 429 and charged to its artifact
//! as a failure, so the first sync of a well-used laptop abandoned whatever did
//! not fit in its first minute. The archive says how long to wait, in
//! `Retry-After`. Waiting that long and sending the same request again is what
//! it asked for.

use reqwest::blocking::{RequestBuilder, Response};
use std::time::Duration;

/// The longest a single wait may be, whatever `Retry-After` says.
const LONGEST_WAIT: Duration = Duration::from_secs(120);

/// The most one request may spend waiting before its 429 is reported. A
/// pass that cannot get through in this long ends, and the watch or the next
/// run picks the queue up.
const PATIENCE: Duration = Duration::from_secs(300);

/// When the archive gives no `Retry-After`.
const DEFAULT_WAIT: Duration = Duration::from_secs(30);

/// Sends `request`, and sends it again after each 429 or 503 the archive
/// answers with, for as long as `PATIENCE` allows. Whatever else comes back,
/// including a transport failure, is returned as it is.
pub(crate) fn send_patiently(
    request: RequestBuilder,
    sleep: impl Fn(Duration),
) -> Result<Response, reqwest::Error> {
    let mut request = request;
    let mut waited = Duration::ZERO;
    loop {
        // A body that cannot be cloned is a stream, and a stream cannot be
        // sent twice. The bodies here are bytes and JSON, which can.
        let again = request.try_clone();
        let response = request.send()?;
        let status = response.status().as_u16();
        let Some(next) = again.filter(|_| matches!(status, 429 | 503)) else {
            return Ok(response);
        };
        let wait = retry_after(&response).min(LONGEST_WAIT);
        if waited + wait > PATIENCE {
            return Ok(response);
        }
        sleep(wait);
        waited += wait;
        request = next;
    }
}

/// `Retry-After` as a number of seconds. The HTTP-date form is not one the
/// archive sends, and is read as the default.
fn retry_after(response: &Response) -> Duration {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(DEFAULT_WAIT, Duration::from_secs)
}
