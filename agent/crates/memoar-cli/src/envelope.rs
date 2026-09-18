use memoar_connectors::SOURCES;
use serde_json::{Value, json};

use crate::CommandOutput;
use crate::error::{
    AppError, EXIT_LOCKED, EXIT_NETWORK, EXIT_NOT_INITIALIZED, EXIT_OK, EXIT_UNKNOWN, EXIT_USAGE,
};

pub const ROBOT_ENVELOPE_VERSION: &str = "1";

#[must_use]
pub fn success_envelope(output: &CommandOutput) -> Value {
    json!({
        "ok": true,
        "version": ROBOT_ENVELOPE_VERSION,
        "command": output.command,
        "data": output.data
    })
}

#[must_use]
pub fn error_envelope(error: &AppError) -> Value {
    json!({ "error": error })
}

#[must_use]
pub fn capabilities_value() -> Value {
    json!({
        "contractVersion": memoar_canonical::CONTRACT_VERSION,
        "clientVersion": env!("CARGO_PKG_VERSION"),
        "robotEnvelopeVersion": ROBOT_ENVELOPE_VERSION,
        "json": true,
        "offlineQueue": "sqlite-wal",
        "contentAddress": "sha256",
        "clientRedaction": ["text", "zip"],
        "opaqueRedaction": "fail-closed",
        "bundleIntegrity": ["bundle-sha256", "file-sha256", "size"],
        "noClobber": true,
        "sources": SOURCES.iter().map(|source| source.id).collect::<Vec<_>>(),
        "materializationTargets": ["claude-code", "codex", "antigravity-cli"]
    })
}

#[must_use]
pub fn introspect_value() -> Value {
    json!({
        "name": "memoar",
        "clientVersion": env!("CARGO_PKG_VERSION"),
        "contractVersion": memoar_canonical::CONTRACT_VERSION,
        "commands": [
            { "name": "login", "requiresAuth": false, "network": true },
            { "name": "status", "requiresAuth": true, "network": false },
            { "name": "sources list", "requiresAuth": false, "network": false },
            { "name": "sources enable", "requiresAuth": true, "network": true },
            { "name": "sources disable", "requiresAuth": true, "network": true },
            { "name": "sync", "requiresAuth": true, "network": true },
            { "name": "redaction", "requiresAuth": true, "network": false },
            { "name": "search", "requiresAuth": true, "network": true },
            { "name": "view", "requiresAuth": true, "network": true },
            { "name": "pack", "requiresAuth": true, "network": true },
            { "name": "convert", "requiresAuth": true, "network": true },
            { "name": "memory convert", "requiresAuth": true, "network": true },
            { "name": "doctor", "requiresAuth": true, "network": true },
            { "name": "capabilities", "requiresAuth": false, "network": false },
            { "name": "introspect", "requiresAuth": false, "network": false }
        ],
        "exitCodes": {
            "ok": EXIT_OK,
            "usage": EXIT_USAGE,
            "notInitialized": EXIT_NOT_INITIALIZED,
            "network": EXIT_NETWORK,
            "lock": EXIT_LOCKED,
            "unknown": EXIT_UNKNOWN
        },
        "errorEnvelope": {
            "fields": ["code", "kind", "message", "hint", "retryable"]
        }
    })
}
