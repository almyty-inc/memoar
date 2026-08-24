//! Canonical Memoar contract types.
//!
//! `generated.rs` is produced from `contracts/source/canonical.model.json`.

#[rustfmt::skip]
mod generated;

pub use generated::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_version_matches_workspace() {
        assert_eq!(CONTRACT_VERSION, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn canonical_fixture_deserializes() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../contracts/fixtures/claude-code/v1/session-1/expected.canonical.json"
        ));
        let session: Session = serde_json::from_str(fixture).expect("fixture is canonical");
        assert!(!session.turns.is_empty());
        assert_eq!(session.source.tool, "claude-code");
    }
}
