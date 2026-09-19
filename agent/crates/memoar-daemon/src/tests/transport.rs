use std::sync::Mutex;

use chrono::{Duration as ChronoDuration, Utc};

use crate::transport::{HttpTransport, UPLOAD_TIMEOUT};

/// A minter that records how many times it was asked, and hands out a token
/// that is good for an hour — what the archive actually issues.
fn counting_minter(calls: &'static Mutex<usize>) -> crate::transport::TokenMinter {
    Box::new(move || {
        *calls.lock().unwrap() += 1;
        let expires = Utc::now() + ChronoDuration::seconds(3600);
        Ok(("minted-token".to_owned(), Some(expires.to_rfc3339())))
    })
}

fn in_seconds(seconds: i64) -> String {
    (Utc::now() + ChronoDuration::seconds(seconds)).to_rfc3339()
}

/// A request must not begin on a credential that can die before it ends.
///
/// The archive validates the bearer once the body has arrived. An upload may
/// run for `UPLOAD_TIMEOUT`, so a token with less than that left is not good
/// enough to start on, however alive it looks right now. The margin used to be
/// 300 seconds against a 1800-second timeout, which meant a request could begin
/// with five minutes of credential and then spend half an hour uploading: every
/// byte sent, then `401` at the end.
#[test]
fn a_token_that_cannot_outlive_an_upload_is_replaced_before_the_request() {
    static CALLS: Mutex<usize> = Mutex::new(0);
    *CALLS.lock().unwrap() = 0;

    let short = UPLOAD_TIMEOUT.as_secs() as i64 - 60;
    let transport = HttpTransport::with_minter(
        "http://127.0.0.1:4000/v1",
        "stale-token",
        Some(&in_seconds(short)),
        Some(counting_minter(&CALLS)),
    );

    let token = transport.usable_token().expect("minting must succeed");
    assert_eq!(
        token,
        "minted-token",
        "a token with {short}s left cannot survive a {}s upload, so it must be re-minted",
        UPLOAD_TIMEOUT.as_secs(),
    );
    assert_eq!(*CALLS.lock().unwrap(), 1);
}

/// The opposite failure, and an easy one to introduce while fixing the first:
/// if the margin swallows the whole lifetime, nothing ever qualifies and the
/// transport mints on every single request without one succeeding.
#[test]
fn a_token_with_room_to_spare_is_reused_rather_than_reminted() {
    static CALLS: Mutex<usize> = Mutex::new(0);
    *CALLS.lock().unwrap() = 0;

    // What the archive issues: an hour, against a thirty-minute upload window.
    let transport = HttpTransport::with_minter(
        "http://127.0.0.1:4000/v1",
        "good-token",
        Some(&in_seconds(3600)),
        Some(counting_minter(&CALLS)),
    );

    for _ in 0..3 {
        assert_eq!(
            transport.usable_token().unwrap(),
            "good-token",
            "an hour-long token covers a half-hour upload and must be kept",
        );
    }
    assert_eq!(
        *CALLS.lock().unwrap(),
        0,
        "re-minting on a perfectly good token means no token ever qualifies",
    );
}

/// Without a minter there is nothing to replace the token with, so refusing
/// here would turn a working single-shot call into an error over a credential
/// that may well still be good.
#[test]
fn a_transport_with_nothing_to_mint_with_keeps_what_it_was_given() {
    let transport = HttpTransport::with_minter(
        "http://127.0.0.1:4000/v1",
        "only-token",
        Some(&in_seconds(5)),
        None,
    );
    assert_eq!(transport.usable_token().unwrap(), "only-token");
}
