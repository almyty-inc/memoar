use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use memoar_canonical::{
    ContentBlock, ContentBlockKind, Session, SourceDescriptor, TokenTotals, Turn, Visibility,
    WorkspaceDescriptor,
};

use crate::bundle::{ConversionBundle, bundle_sha256, content_sha256};

pub(crate) fn fixture_session() -> Session {
    Session {
        id: "0198d8d0-977c-777b-9f8f-0f6d8416e701".to_owned(),
        source: SourceDescriptor {
            vendor: "anthropic".to_owned(),
            tool: "claude-code".to_owned(),
            version: "1".to_owned(),
            machine_id: "0198d8d0-977c-777b-9f8f-0f6d8416e702".to_owned(),
            native_session_id: None,
        },
        workspace: WorkspaceDescriptor {
            path: "/tmp/project".to_owned(),
            git_remote: None,
            branch: None,
        },
        created_at: "2026-08-17T10:00:00Z".to_owned(),
        updated_at: "2026-08-17T10:01:00Z".to_owned(),
        title: "Test".to_owned(),
        summary: None,
        models: vec!["model".to_owned()],
        token_totals: TokenTotals {
            input: 10,
            output: 5,
            cache_read: None,
            cache_write: None,
        },
        provenance: Vec::new(),
        visibility: Visibility {
            scope: "private".to_owned(),
            owner_id: "0198d8d0-977c-777b-9f8f-0f6d8416e703".to_owned(),
            team_id: None,
            org_id: None,
        },
        turns: vec![Turn {
            id: "0198d8d0-977c-777b-9f8f-0f6d8416e704".to_owned(),
            ordinal: 0,
            parent_id: None,
            role: "user".to_owned(),
            created_at: "2026-08-17T10:00:00Z".to_owned(),
            model: None,
            tokens: None,
            blocks: vec![ContentBlock {
                id: "0198d8d0-977c-777b-9f8f-0f6d8416e705".to_owned(),
                kind: ContentBlockKind::Text,
                text: Some("hello".to_owned()),
                name: None,
                call_id: None,
                language: None,
                mime_type: None,
                artifact_ref: None,
                data: None,
                ext: None,
            }],
            ext: None,
        }],
        ext: None,
    }
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
