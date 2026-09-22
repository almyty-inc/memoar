use memoar_materializer::ConversionBundle;
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde_json::{Value, json};
use std::time::Duration;

use crate::credential::Credential;
use crate::error::AppError;

/// A dead host should not cost a whole download budget to discover.
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a control-plane request may take.
///
/// Registering a machine, minting a token, listing sessions: all of them are a
/// few kilobytes of JSON, and one that has not answered in two minutes is not
/// going to. This budget is deliberately not the one a bundle download gets.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// The largest conversion bundle the materializer will accept, decoded.
///
/// It caps a single file at 512 MiB and the bundle's total at twice that, so
/// this is the most bytes a `convert --here` can legitimately be waiting for.
/// Declared here rather than imported so the download budget is not silently
/// re-tuned by a change in another crate: if the materializer's ceiling moves,
/// this constant and the test below are what notice.
pub const MAX_CONVERSION_BUNDLE_BYTES: u64 = 2 * 512 * 1024 * 1024;

/// Bundle files travel base64-encoded, which costs four bytes per three.
pub const BASE64_EXPANSION_NUMERATOR: u64 = 4;
pub const BASE64_EXPANSION_DENOMINATOR: u64 = 3;

/// The slowest uplink a download is still expected to finish on: 2 Mbit/s.
/// The same floor the upload path is budgeted for. Below it the agent is
/// entitled to give up; at or above it, a timeout that fires is a bug in the
/// timeout, not a slow network.
pub const SLOWEST_TOLERATED_BYTES_PER_SEC: u64 = 256 * 1024;

/// How long a conversion bundle download may take.
///
/// Not a free parameter: it has to cover `MAX_CONVERSION_BUNDLE_BYTES`, base64
/// expanded, at `SLOWEST_TOLERATED_BYTES_PER_SEC`, and a test holds it to that.
/// reqwest's 30-second default did not cover 8 MB, so every non-trivial
/// `memoar convert --here` failed on a deadline it could never meet — the same
/// defect already fixed on the upload side, left standing on this one.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

pub(crate) struct ApiClient {
    pub(crate) client: Client,
    endpoint: String,
    credential: Option<Credential>,
    /// What a bundle download gets instead of `REQUEST_TIMEOUT`. A field rather
    /// than a constant at the call site so a test can prove the download path
    /// uses this budget and not the control-plane one.
    download_timeout: Duration,
}

impl ApiClient {
    pub(crate) fn new(endpoint: &str, credential: Option<&Credential>) -> Self {
        Self::with_timeouts(endpoint, credential, REQUEST_TIMEOUT, DOWNLOAD_TIMEOUT)
    }

    pub(crate) fn with_timeouts(
        endpoint: &str,
        credential: Option<&Credential>,
        request: Duration,
        download: Duration,
    ) -> Self {
        Self {
            // A whole-request cap is the wrong shape for a client that both asks
            // small questions and pulls a bundle: one budget cannot be both
            // short enough to notice a dead archive and long enough to carry
            // half a gigabyte. So: fail fast on connect, keep the short budget
            // for JSON, and let the download ask for its own.
            client: Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(request)
                .build()
                .expect("static HTTP client configuration must be valid"),
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            credential: credential.cloned(),
            download_timeout: download,
        }
    }

    pub(crate) fn authorize(&self, request: RequestBuilder) -> RequestBuilder {
        // An API key is a header the server looks up directly; a bearer token is
        // verified as a signed token. Sending a key as a bearer authenticates
        // nobody, so the two are not interchangeable at the wire.
        match &self.credential {
            Some(Credential::ApiKey(secret)) => request.header("x-memoar-key", secret),
            Some(Credential::Bearer(token)) => request.bearer_auth(token),
            None => request,
        }
    }

    pub(crate) fn post(&self, path: &str, body: &Value) -> Result<Value, AppError> {
        self.send_json(self.authorize(self.client.post(self.url(path))).json(body))
    }

    pub(crate) fn patch(&self, path: &str, body: &Value) -> Result<Value, AppError> {
        self.send_json(self.authorize(self.client.patch(self.url(path))).json(body))
    }

    pub(crate) fn get(&self, path: &str) -> Result<Value, AppError> {
        self.send_json(self.authorize(self.client.get(self.url(path))))
    }

    pub(crate) fn get_query(
        &self,
        path: &str,
        query: &[(impl AsRef<str>, String)],
    ) -> Result<Value, AppError> {
        let query: Vec<_> = query
            .iter()
            .map(|(key, value)| (key.as_ref(), value.as_str()))
            .collect();
        self.send_json(
            self.authorize(self.client.get(self.url(path)))
                .query(&query),
        )
    }

    pub(crate) fn download_conversion(&self, path: &str) -> Result<ConversionBundle, AppError> {
        let bytes = self.send_bytes(
            self.authorize(self.client.get(self.url(path)))
                .timeout(self.download_timeout),
        )?;
        if let Ok(bundle) = serde_json::from_slice::<ConversionBundle>(&bytes) {
            return Ok(bundle);
        }
        let response: Value = serde_json::from_slice(&bytes)
            .map_err(|error| AppError::network(format!("invalid download response: {error}")))?;
        let url = response
            .get("url")
            .or_else(|| response.get("downloadUrl"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::network("download response did not include a bundle or URL")
            })?;
        // The redirect to storage carries the same bytes, so it carries the
        // same budget: the 30-second default cut this one off too.
        let bytes = self.send_bytes(self.client.get(url).timeout(self.download_timeout))?;
        serde_json::from_slice(&bytes)
            .map_err(|error| AppError::network(format!("invalid conversion bundle: {error}")))
    }

    fn send_json(&self, request: RequestBuilder) -> Result<Value, AppError> {
        let response = self.send(request)?;
        if response.status().as_u16() == 204 {
            return Ok(json!({}));
        }
        response
            .json()
            .map_err(|error| AppError::network(format!("invalid JSON response: {error}")))
    }

    pub(crate) fn send_bytes(&self, request: RequestBuilder) -> Result<Vec<u8>, AppError> {
        self.send(request)?
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|error| AppError::network(transport_message(&error)))
    }

    fn send(&self, request: RequestBuilder) -> Result<Response, AppError> {
        let response = request
            .send()
            .map_err(|error| AppError::network(transport_message(&error)))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(AppError::network(problem_message(status.as_u16(), &body)));
        }
        Ok(response)
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoint, path)
    }
}

/// A transport failure the operator can act on.
///
/// `reqwest::Error` renders as "error sending request for url (...)" and keeps
/// the reason — connection reset, timed out, certificate — in its source chain.
/// Printing only the top of that chain is why `memoar login` behind a
/// TLS-inspecting proxy reported the URL and nothing about the certificate, and
/// the operator had no way to tell a refused connection from a rejected one.
/// The daemon walks the chain for exactly this reason; so does this.
fn transport_message(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    if error.is_timeout() {
        message.push_str(" (timed out)");
    }
    redact_query(&message, error.url())
}

/// Takes the query string out of the URL `reqwest` prints.
///
/// A conversion bundle is fetched from a pre-signed storage URL, and the
/// signature in its query string *is* the credential: anyone holding that
/// string can fetch the object until it expires. `reqwest` renders a transport
/// failure as "error sending request for url (<the whole URL>)", so any
/// failure on that download — a reset, a proxy, a timeout — printed
/// `X-Amz-Signature` on the terminal. `listen` then posted the same text back
/// to the archive as the command's failure reason, so it also came to rest in
/// the machine's command record.
///
/// The host and path stay, because they are the diagnosis; only the part that
/// is a secret goes.
fn redact_query(message: &str, url: Option<&reqwest::Url>) -> String {
    let Some(url) = url.filter(|url| url.query().is_some()) else {
        return message.to_owned();
    };
    let mut redacted = url.clone();
    redacted.set_query(Some("<redacted>"));
    message.replace(url.as_str(), redacted.as_str())
}

/// What to say when the archive refuses a request.
///
/// The server answers with an RFC 9457 problem document, and this printed the
/// document: a stale credential produced `HTTP 401 Unauthorized:
/// {"type":"https://memoar.dev/problems/unauthorized","title":"Unauthorized",
/// "status":401,...}` on the terminal. The web client had the same defect.
pub(crate) fn problem_message(status: u16, body: &str) -> String {
    let described = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|problem| {
            let field = |name: &str| problem.get(name).and_then(Value::as_str).map(str::to_owned);
            field("detail").or_else(|| field("title"))
        })
        .unwrap_or_else(|| status_sentence(status));
    format!("{described} (HTTP {status})")
}

/// The fallback when the body says nothing worth reading.
pub(crate) fn status_sentence(status: u16) -> String {
    match status {
        401 => "This machine is not signed in. Run `memoar login`.".to_owned(),
        403 => "These credentials do not allow that.".to_owned(),
        404 => "The archive has no such thing.".to_owned(),
        409 => "That conflicts with something already in the archive.".to_owned(),
        413 => "That is larger than the archive accepts.".to_owned(),
        429 => "Too many requests. Wait a moment and retry.".to_owned(),
        500..=599 => "The archive is having trouble. Retry shortly.".to_owned(),
        _ => "The request failed.".to_owned(),
    }
}
