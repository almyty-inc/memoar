//! Whether this client and its archive speak the same contract.
//!
//! The check used to compare the client with `contractVersion` in its own
//! config.json. That value is written once and nothing moved it forward on an
//! upgrade, so every upgraded install failed the check forever, and the
//! comparison it was standing in for was never made. The one that matters is
//! the client against the archive: the materializer refuses a bundle whose
//! contract is not its own, so a mismatch there is what breaks `convert` and
//! `memory` on this machine.
//!
//! The archive publishes its contract on `GET /capabilities`. An archive that
//! cannot be asked, or answers without a version, leaves the check `null`, the
//! same as every other check that could not be measured.

use serde_json::{Value, json};

use crate::api::ApiClient;

pub(crate) fn contract_check(api: &ApiClient, endpoint: &str) -> Value {
    let client = memoar_canonical::CONTRACT_VERSION;
    let archive = match api.get("/capabilities") {
        Ok(body) => body
            .get("contractVersion")
            .and_then(Value::as_str)
            .map(str::to_owned),
        Err(error) => {
            return verdict(
                None,
                format!(
                    "this client speaks {client}, and the archive did not answer /capabilities: {}",
                    error.message
                ),
                None,
            );
        }
    };
    match archive {
        Some(archive) if archive == client => verdict(
            Some(true),
            format!("this client and {endpoint} both speak {client}"),
            None,
        ),
        Some(archive) => verdict(
            Some(false),
            format!(
                "this client speaks {client}, {endpoint} speaks {archive}, so bundles it sends will be refused"
            ),
            Some("upgrade whichever of the two is older so both speak the same contract"),
        ),
        None => verdict(
            None,
            format!(
                "this client speaks {client}, and {endpoint} did not say which contract it speaks"
            ),
            None,
        ),
    }
}

fn verdict(ok: Option<bool>, detail: String, hint: Option<&str>) -> Value {
    let mut check = json!({ "name": "contract_version", "ok": ok, "detail": detail });
    if let Some(hint) = hint {
        check["hint"] = json!(hint);
    }
    check
}
