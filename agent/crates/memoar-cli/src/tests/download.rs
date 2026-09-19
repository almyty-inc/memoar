use serde_json::json;
use std::time::Duration;

use super::mock::{MockOptions, spawn_mock};
use crate::api::{ApiClient, CONNECT_TIMEOUT, REQUEST_TIMEOUT};
use crate::{
    BASE64_EXPANSION_DENOMINATOR, BASE64_EXPANSION_NUMERATOR, DOWNLOAD_TIMEOUT,
    MAX_CONVERSION_BUNDLE_BYTES, SLOWEST_TOLERATED_BYTES_PER_SEC,
};

/// The download deadline has to be reachable for the largest bundle the
/// materializer will accept.
///
/// reqwest's blocking client caps a whole request at 30 seconds by default,
/// and `ApiClient` took that default on every request including this one.
/// At the slowest uplink the upload path is budgeted for, 30 seconds buys
/// about 7.5 MB, so every non-trivial `memoar convert --here` failed on a
/// deadline it could never meet, with no retry. This fails if the budget
/// drops or the size ceiling rises without the other moving too.
#[test]
fn the_download_deadline_is_reachable_at_the_size_ceiling() {
    let on_the_wire =
        MAX_CONVERSION_BUNDLE_BYTES * BASE64_EXPANSION_NUMERATOR / BASE64_EXPANSION_DENOMINATOR;
    let needed = on_the_wire / SLOWEST_TOLERATED_BYTES_PER_SEC;
    assert!(
        DOWNLOAD_TIMEOUT.as_secs() >= needed,
        "a {MAX_CONVERSION_BUNDLE_BYTES}-byte bundle is {on_the_wire} bytes base64 and \
         needs {needed}s at the slowest tolerated uplink, but downloads are cut off after {}s",
        DOWNLOAD_TIMEOUT.as_secs()
    );
    assert!(
        CONNECT_TIMEOUT < REQUEST_TIMEOUT && REQUEST_TIMEOUT < DOWNLOAD_TIMEOUT,
        "an unreachable host must fail long before a slow download does"
    );
}

/// And the budget must actually reach the request that needs it.
#[test]
fn a_bundle_download_is_not_held_to_the_control_plane_budget() {
    let bundle = json!({ "contractVersion": "unreadable" });
    let (endpoint, _requests, _server) = spawn_mock(MockOptions {
        request_count: 1,
        conversion_bundle: Some(bundle),
        slow_path: "/download",
        slow_by: Duration::from_millis(900),
        ..MockOptions::default()
    });
    let api = ApiClient::with_timeouts(
        &endpoint,
        None,
        Duration::from_millis(400),
        Duration::from_secs(10),
    );

    // The bundle is deliberately not a bundle: what is being tested is that
    // the bytes arrived at all, not what they say.
    let outcome = api.download_conversion("/convert/conversion-job/download");
    assert!(
        !matches!(&outcome, Err(error) if error.message.contains("timed out")),
        "the download was held to the control-plane budget: {outcome:?}"
    );

    let (endpoint, _requests, _server) = spawn_mock(MockOptions {
        request_count: 1,
        slow_path: "/machines",
        slow_by: Duration::from_millis(900),
        ..MockOptions::default()
    });
    let api = ApiClient::with_timeouts(
        &endpoint,
        None,
        Duration::from_millis(400),
        Duration::from_secs(10),
    );
    let error = api
        .get("/machines")
        .expect_err("a control request must keep the short budget");
    assert!(
        error.message.contains("timed out"),
        "unexpected failure: {error:?}"
    );
}

/// "error sending request for url (…)" is not something an operator can act
/// on. Behind a TLS-inspecting proxy it was the whole message: the URL, and
/// nothing about the certificate. The reason is in the source chain.
#[test]
fn a_transport_failure_says_why() {
    let endpoint = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}/v1", listener.local_addr().unwrap())
    };
    let error = ApiClient::new(&endpoint, None)
        .get("/machines")
        .expect_err("nothing is listening on that port");
    assert!(
        error.message.to_lowercase().contains("refused"),
        "the reason was dropped with the source chain: {}",
        error.message
    );
}
