//! The three file editors `integrate` uses keep everything that is not
//! memoar's, and change nothing on a second run.

use serde_json::json;
use std::path::Path;

use crate::integrate::{json_file, toml_file, yaml_file};

fn entry() -> serde_json::Value {
    json!({ "command": "/opt/memoar", "args": ["mcp"] })
}

#[test]
fn jsonc_keeps_comments_and_other_servers() {
    let path = Path::new("settings.json");
    let original = r#"{
  // Zed writes this comment into every new settings file.
  "theme": "One Dark",
  "context_servers": {
    "other": { "command": "other", "args": [] },
  },
}
"#;
    let installed = json_file::install(
        path,
        Some(original),
        &["context_servers"],
        "memoar",
        &entry(),
    )
    .unwrap();
    assert!(installed.contains("// Zed writes this comment"));
    assert!(installed.contains(r#""theme": "One Dark""#));
    assert!(installed.contains(r#""other""#));
    assert_eq!(
        json_file::current(path, &installed, &["context_servers"], "memoar"),
        Some(entry())
    );

    let again = json_file::install(
        path,
        Some(&installed),
        &["context_servers"],
        "memoar",
        &entry(),
    )
    .unwrap();
    assert_eq!(again, installed, "a second run must change nothing");

    let removed = json_file::uninstall(path, &installed, &["context_servers"], "memoar")
        .unwrap()
        .expect("memoar's entry was there to remove");
    assert!(removed.contains("// Zed writes this comment"));
    assert!(removed.contains(r#""other""#));
    assert!(!removed.contains("memoar"));
    assert_eq!(
        json_file::uninstall(path, &removed, &["context_servers"], "memoar").unwrap(),
        None
    );
}

#[test]
fn json_entry_is_updated_in_place_when_it_differs() {
    let path = Path::new("mcp.json");
    let old = r#"{"mcpServers":{"memoar":{"command":"memoar","args":["mcp"]}}}"#;
    let next = json_file::install(path, Some(old), &["mcpServers"], "memoar", &entry()).unwrap();
    assert_eq!(
        json_file::current(path, &next, &["mcpServers"], "memoar"),
        Some(entry())
    );
}

#[test]
fn json_that_is_not_an_object_is_refused_not_replaced() {
    let path = Path::new("mcp.json");
    let error = json_file::install(
        path,
        Some(r#"{"mcpServers": []}"#),
        &["mcpServers"],
        "memoar",
        &entry(),
    )
    .unwrap_err();
    assert!(
        error.message.contains("not a JSON object"),
        "{}",
        error.message
    );
    assert!(json_file::install(path, Some("{ nope"), &["mcpServers"], "memoar", &entry()).is_err());
}

#[test]
fn toml_keeps_comments_and_other_tables() {
    let path = Path::new("config.toml");
    let original =
        "# my codex settings\nmodel = \"o3\"\n\n[mcp_servers.other]\ncommand = \"other\"\n";
    let installed =
        toml_file::install(path, Some(original), "mcp_servers", "memoar", &entry()).unwrap();
    assert!(installed.starts_with("# my codex settings\nmodel = \"o3\""));
    assert!(installed.contains("[mcp_servers.other]"));
    assert!(installed.contains("[mcp_servers.memoar]"));
    assert!(
        !installed.contains("[mcp_servers]\n"),
        "no bare parent header"
    );
    assert_eq!(
        toml_file::current(path, &installed, "mcp_servers", "memoar"),
        Some(entry())
    );
    let again =
        toml_file::install(path, Some(&installed), "mcp_servers", "memoar", &entry()).unwrap();
    assert_eq!(again, installed);

    let removed = toml_file::uninstall(path, &installed, "mcp_servers", "memoar")
        .unwrap()
        .unwrap();
    assert!(removed.contains("[mcp_servers.other]"));
    assert!(!removed.contains("memoar"));
}

#[test]
fn goose_yaml_inserts_beside_other_extensions() {
    let path = Path::new("config.yaml");
    let original = "GOOSE_PROVIDER: openai\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n\nGOOSE_MODEL: gpt-4o\n";
    let entry = json!({ "cmd": "/opt/memoar", "args": ["mcp"], "envs": {}, "enabled": true });
    let installed =
        yaml_file::install(path, Some(original), "extensions", "memoar", &entry).unwrap();
    assert!(installed.contains("  developer:\n    enabled: true\n    type: builtin"));
    assert!(installed.contains("  memoar:\n    args:\n      - \"mcp\"\n"));
    assert!(installed.ends_with("GOOSE_MODEL: gpt-4o\n"));
    assert_eq!(
        yaml_file::current(&installed, "extensions", "memoar", &entry),
        Some(true)
    );
    assert_eq!(
        yaml_file::install(path, Some(&installed), "extensions", "memoar", &entry).unwrap(),
        installed
    );

    let moved =
        json!({ "cmd": "/usr/local/bin/memoar", "args": ["mcp"], "envs": {}, "enabled": true });
    assert_eq!(
        yaml_file::current(&installed, "extensions", "memoar", &moved),
        Some(false)
    );
    let updated =
        yaml_file::install(path, Some(&installed), "extensions", "memoar", &moved).unwrap();
    assert!(updated.contains("/usr/local/bin/memoar"));
    assert!(!updated.contains("\"/opt/memoar\""));
    assert_eq!(updated.matches("  memoar:").count(), 1);

    let removed = yaml_file::uninstall(path, &updated, "extensions", "memoar")
        .unwrap()
        .unwrap();
    assert_eq!(removed, original);
}

#[test]
fn goose_yaml_without_extensions_gains_the_key() {
    let path = Path::new("config.yaml");
    let entry = json!({ "cmd": "memoar", "args": ["mcp"] });
    let created = yaml_file::install(path, None, "extensions", "memoar", &entry).unwrap();
    assert_eq!(
        created,
        "extensions:\n  memoar:\n    args:\n      - \"mcp\"\n    cmd: \"memoar\"\n"
    );
    let empty_map = yaml_file::install(
        path,
        Some("extensions: {}\n"),
        "extensions",
        "memoar",
        &entry,
    )
    .unwrap();
    assert_eq!(empty_map, created);
    assert!(
        yaml_file::install(
            path,
            Some("extensions: [a]\n"),
            "extensions",
            "memoar",
            &entry
        )
        .is_err(),
        "a flow-style value is refused rather than guessed at"
    );
}
