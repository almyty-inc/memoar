use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::json;

use crate::bundle::{BundleFile, ConversionBundle, bundle_sha256, content_sha256};
use crate::target::Target;

pub(crate) const SESSION_ID: &str = "0198d8d0-977c-777b-9f8f-0f6d8416e701";

/// A bundle of one file, with its digests filled in.
pub(crate) fn single_file_bundle(target: Target, path: &str, content: &[u8]) -> ConversionBundle {
    finalized_bundle(ConversionBundle {
        contract_version: memoar_canonical::CONTRACT_VERSION.to_owned(),
        bundle_version: "1".to_owned(),
        bundle_sha256: String::new(),
        target,
        session_id: SESSION_ID.to_owned(),
        files: vec![BundleFile {
            path: path.to_owned(),
            media_type: "application/x-ndjson".to_owned(),
            base64: BASE64.encode(content),
            sha256: String::new(),
            size: 0,
        }],
        resume_command: format!("claude -r {SESSION_ID}"),
        report: json!({"mapped": 1, "degraded": [], "dropped": [], "fallback": false}),
    })
}

pub(crate) fn finalized_bundle(mut bundle: ConversionBundle) -> ConversionBundle {
    for file in &mut bundle.files {
        let bytes = BASE64.decode(file.base64.as_bytes()).unwrap();
        file.size = bytes.len() as u64;
        file.sha256 = content_sha256(&bytes);
    }
    bundle.bundle_sha256 = bundle_sha256(&bundle).unwrap();
    bundle
}
