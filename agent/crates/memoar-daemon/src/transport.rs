//! The HTTP transport: its credential, its timeouts, and its error reporting.

use chrono::{DateTime, Utc};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use crate::error::DaemonError;
use crate::manifest::{IngestManifest, IngestReceipt, SyncTransport};
use crate::queue::QueuedArtifact;

/// The machine token the transport is currently using, and when it dies.
struct Credential {
    token: String,
    expires_at: Option<DateTime<Utc>>,
}

/// Mints a fresh machine token. Supplied by the caller, because minting needs
/// the account credential and that lives a layer up.
pub type TokenMinter = Box<dyn Fn() -> Result<(String, Option<String>), DaemonError> + Send + Sync>;

/// How much life a machine token must have left before a request will use it.
///
/// A machine token lives 900 seconds. A single upload may run for
/// `UPLOAD_TIMEOUT`. The server validates the bearer once the body has
/// arrived, so a large transcript pushed on a token minted at the start of a
/// batch was authenticated against a credential that had already expired —
/// twenty-six artifacts in a real drain died on
/// `401 Valid bearer, machine, or API-key credentials are required`, having
/// uploaded every byte first.
///
/// Re-minting before each request cannot make a token outlive its own TTL, so
/// an upload slower than the full lifetime still cannot be authenticated. What
/// it does guarantee is that no request ever *starts* on a credential that is
/// about to die, which is what was actually happening.
const CREDENTIAL_MARGIN: Duration = Duration::from_secs(300);

pub struct HttpTransport {
    client: Client,
    endpoint: String,
    credential: Mutex<Credential>,
    mint: Option<TokenMinter>,
}

/// The largest artifact the archive accepts, mirroring `MEMOAR_MAX_ARTIFACT_BYTES`
/// on the API and `proxy-body-size` on the ingress.
pub const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;

/// The slowest uplink an upload is still expected to finish on: 2 Mbit/s.
/// Below this the agent is entitled to give up; at or above it, a timeout that
/// fires is a bug in the timeout, not a slow network.
pub const SLOWEST_TOLERATED_UPLOAD_BYTES_PER_SEC: u64 = 256 * 1024;

/// How long a single artifact upload may take.
///
/// This is not a free parameter: it has to cover `MAX_ARTIFACT_BYTES` at
/// `SLOWEST_TOLERATED_UPLOAD_BYTES_PER_SEC`, and a test holds it to that. The
/// reqwest default of 30 seconds did not, so every transcript over roughly
/// 30 MB failed on a deadline it could never meet and retried forever.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// A dead host should not cost a whole upload budget to discover.
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

impl HttpTransport {
    #[must_use]
    pub fn new(endpoint: impl Into<String>, machine_token: impl Into<String>) -> Self {
        Self::with_minter(endpoint, machine_token, None, None)
    }

    /// A transport that can replace its own machine token when the one it holds
    /// is close to expiry.
    #[must_use]
    pub fn with_minter(
        endpoint: impl Into<String>,
        machine_token: impl Into<String>,
        expires_at: Option<&str>,
        mint: Option<TokenMinter>,
    ) -> Self {
        Self {
            // `Client::new()` is a 30-second cap on the whole request, which is
            // the wrong shape for this: the payload is a transcript, and every
            // artifact that takes longer than 30 seconds to push fails, retries,
            // and fails again. Seven sessions between 26 MB and 116 MB retried
            // twenty times against a deadline none of them could ever meet.
            //
            // So: fail fast when the host is unreachable, and then let the body
            // take as long as a 256 MB ceiling needs on a domestic uplink. The
            // outer bound still exists so a stalled socket cannot hang a sync
            // forever.
            client: Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(UPLOAD_TIMEOUT)
                .tcp_keepalive(Duration::from_secs(30))
                .build()
                .expect("static HTTP client configuration must be valid"),
            endpoint: endpoint.into().trim_end_matches('/').to_owned(),
            credential: Mutex::new(Credential {
                token: machine_token.into(),
                expires_at: expires_at.and_then(parse_expiry),
            }),
            mint,
        }
    }

    /// The token to start a request with, re-minted if the one held is within
    /// `CREDENTIAL_MARGIN` of expiry.
    ///
    /// A transport with no minter keeps whatever it was given: that is the
    /// single-shot case, and failing here would turn a working call into an
    /// error over a token that may well still be good.
    fn usable_token(&self) -> Result<String, DaemonError> {
        let mut credential = self
            .credential
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(mint) = self.mint.as_ref() else {
            return Ok(credential.token.clone());
        };
        if let Some(expires_at) = credential.expires_at {
            let remaining = expires_at.signed_duration_since(Utc::now());
            if remaining
                > chrono::Duration::from_std(CREDENTIAL_MARGIN).unwrap_or(chrono::Duration::zero())
            {
                return Ok(credential.token.clone());
            }
        }
        let (token, expires_at) = mint()?;
        credential.token = token.clone();
        credential.expires_at = expires_at.as_deref().and_then(parse_expiry);
        Ok(token)
    }

    fn authorize(
        &self,
        request: reqwest::blocking::RequestBuilder,
    ) -> Result<reqwest::blocking::RequestBuilder, DaemonError> {
        Ok(request.bearer_auth(self.usable_token()?))
    }

    /// Posts JSON to a path under the endpoint and refuses anything but success.
    pub(crate) fn post_json<B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<reqwest::blocking::Response, DaemonError> {
        let response = self
            .authorize(self.client.post(format!("{}{path}", self.endpoint)))?
            .json(body)
            .send()
            .map_err(|error| transport_error(&error))?;
        require_success(response)
    }
}

/// An RFC 3339 instant, or nothing. An expiry the agent cannot read is treated
/// as no expiry rather than as an immediate one: guessing "expired" would
/// re-mint on every single request.
fn parse_expiry(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

impl SyncTransport for HttpTransport {
    fn missing(&self, machine_id: &str, hashes: &[String]) -> Result<HashSet<String>, DaemonError> {
        let response = self
            .authorize(self.client.post(format!("{}/ingest/delta", self.endpoint)))?
            .json(&serde_json::json!({ "machineId": machine_id, "hashes": hashes }))
            .send()
            .map_err(|error| transport_error(&error))?;
        let response = require_success(response)?;
        #[derive(Deserialize)]
        struct Delta {
            missing: Vec<String>,
        }
        response
            .json::<Delta>()
            .map(|delta| delta.missing.into_iter().collect())
            .map_err(|error| DaemonError::Protocol(error.to_string()))
    }

    fn upload(&self, artifact: &QueuedArtifact, bytes: Vec<u8>) -> Result<(), DaemonError> {
        let response = self
            .authorize(self.client.put(format!(
                "{}/ingest/artifacts/{}",
                self.endpoint, artifact.sha256
            )))?
            .header("x-memoar-source", &artifact.source)
            .header("x-memoar-source-path", &artifact.source_path)
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .map_err(|error| transport_error(&error))?;
        require_success(response).map(|_| ())
    }

    fn submit_manifest(&self, manifest: &IngestManifest) -> Result<IngestReceipt, DaemonError> {
        let response = self
            .authorize(
                self.client
                    .post(format!("{}/ingest/manifests", self.endpoint)),
            )?
            .json(manifest)
            .send()
            .map_err(|error| transport_error(&error))?;
        require_success(response)?
            .json::<IngestReceipt>()
            .map_err(|error| DaemonError::Protocol(error.to_string()))
    }
}

/// A transport failure the operator can act on.
///
/// `reqwest::Error` renders as "error sending request for url (...)" and keeps
/// the reason — connection reset, timed out, TLS — in its source chain. Seven
/// large transcripts retried twenty times against an error message that never
/// said why; the queue recorded the URL and nothing else.
fn transport_error(error: &reqwest::Error) -> DaemonError {
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
    DaemonError::Transport(message)
}

fn require_success(
    response: reqwest::blocking::Response,
) -> Result<reqwest::blocking::Response, DaemonError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().unwrap_or_default();
    Err(DaemonError::Transport(format!("HTTP {status}: {body}")))
}
