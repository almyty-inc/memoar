//! The capture table: every source this agent knows how to find.

use crate::spec::{SourceSpec, Stability};

const NONE: &[&str] = &[];

pub static SOURCES: &[SourceSpec] = &[
    SourceSpec {
        id: "claude-code",
        display_name: "Claude Code",
        tier: 1,
        format: "JSONL parentUuid stream",
        stability: Stability::Internal,
        // The transcripts, not the trees the sessions built beside them. These
        // were bare directories, and a bare directory means everything beneath
        // it: on one machine that was 5,392 files — markdown, TypeScript,
        // Python, JPEGs and node_modules the agent had written into its own
        // working directory — offered to the uploader by a source that promises
        // session stores and nothing else.
        //
        // A session and the subagents it ran are one conversation. The
        // subagent transcripts sit one directory below the session that spawned
        // them, and `projects/*/*.jsonl` alone reaches none of them: on this
        // machine that is 233 files holding 58,467 lines that carry both `uuid`
        // and `message` — the two fields the parser turns into turns — against
        // 15 top-level transcripts. Narrowing the sweep must not throw those
        // away, so each depth they are written at is named, and only `.jsonl`
        // at that depth: `subagents/*.meta.json` and `tool-results/**` sit
        // beside them and are not transcripts.
        //
        // `.claude/history.jsonl` is not one either. It is the prompt history
        // the CLI keeps for its own up-arrow: 10,619 lines on this machine,
        // every one valid JSON, every one `{display, pastedContents, timestamp,
        // project, sessionId}` and not one carrying `uuid` or `message`. The
        // parser needs both, so all 2.8 MB of it was uploaded on every sync —
        // it grows with every prompt typed — and came back `unknown_format`,
        // carrying every prompt and every paste with it. The conversation it
        // indexes is the transcript named by its own `sessionId`, which
        // `.claude/projects/*/*.jsonl` already takes.
        common_paths: &[
            ".claude/projects/*/*.jsonl",
            ".claude/projects/*/*/subagents/*.jsonl",
            ".claude/projects/*/*/subagents/workflows/*/*.jsonl",
        ],
        linux_paths: NONE,
        // `claude-code-sessions/*/*/local_*.json` and its local-agent-mode twin
        // held no conversation. They are the desktop app's per-session
        // settings: model, permission mode, allowed egress domains, the
        // rendered system prompt, `accountName` and `emailAddress`. Checked on
        // this machine, 22 files matched the two patterns and not one contained
        // a message, a `parentUuid` or a transcript — the parser reads JSONL
        // records carrying `uuid` and `message`, so every one was uploaded and
        // came back `unknown_format`, carrying an email address with it.
        //
        // The conversation those files describe is the CLI transcript named by
        // their own `cliSessionId`, which `.claude/projects/*/*.jsonl` above
        // already captures when it is on this host.
        //
        // A local-agent-mode session keeps its own Claude Code home on this
        // side of the VM, and its transcripts are CLI JSONL: 22 sessions and
        // 27 subagents on the machine checked. Only those are named. The rest
        // of that tree (`.audit-key`, `.claude.json`, plugin `.git`, outputs)
        // is what dev received in 2026-09, and `audit.jsonl` is a signed copy
        // of the same conversation. See contracts/fixtures/PROVENANCE.md.
        macos_paths: &[
            "Library/Application Support/Claude/local-agent-mode-sessions/*/*/local_*/.claude/projects/*/*.jsonl",
            "Library/Application Support/Claude/local-agent-mode-sessions/*/*/local_*/.claude/projects/*/*/subagents/*.jsonl",
            "Library/Application Support/Claude/local-agent-mode-sessions/*/*/agent/local_*/.claude/projects/*/*.jsonl",
            "Library/Application Support/Claude/local-agent-mode-sessions/*/*/agent/local_*/.claude/projects/*/*/subagents/*.jsonl",
        ],
        windows_paths: NONE,
        environment_override: None,
        environment_roots: NONE,
    },
    SourceSpec {
        id: "codex",
        display_name: "Codex CLI",
        tier: 1,
        format: "typed rollout JSONL",
        stability: Stability::Internal,
        // Codex compresses a rollout nobody has touched for a while to
        // `rollout-*.jsonl.zst` and deletes the `.jsonl`
        // (`codex-rs/rollout/src/compression.rs`). Naming only `.jsonl` lost
        // 3,405 of the 3,879 rollouts on the machine checked on 2026-11-26.
        // The agent decompresses before redaction and upload, and tells the
        // archive the plain name, so a rollout that moves between the two
        // stays one session.
        common_paths: &[
            ".codex/sessions/*/*/*/rollout-*.jsonl",
            ".codex/sessions/*/*/*/rollout-*.jsonl.zst",
        ],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: NONE,
        environment_override: Some("CODEX_HOME"),
        environment_roots: &[".codex"],
    },
    SourceSpec {
        id: "antigravity-cli",
        display_name: "Antigravity CLI",
        tier: 1,
        format: "brain directory",
        stability: Stability::Internal,
        // The transcript log, which is the only thing the parser reads: it
        // takes JSON lines and has no SQLite branch at all, whatever its own
        // "requires a native SQLite trajectory database" diagnostic says.
        //
        // `brain/*/conversations/*.db` named a directory that does not exist.
        // On the machine that runs this tool the conversation databases are one
        // level up, in `.gemini/antigravity-cli/conversations/*.db`, and
        // `brain/<id>/` holds only `.system_generated` and `.user_uploaded`.
        // Those databases hold each step as a protobuf blob with no published
        // schema. Checked on 2026-11-26 against all 655 conversations on one
        // machine: every `.db` has its `transcript.jsonl`, the newest included,
        // and every transcript step is a `steps` row at the same index. The
        // rows the transcript leaves out are 519 model errors (HTTP 429
        // details) and 40 cancelled tool calls. So the transcript stays the
        // capture, and the databases stay on the machine.
        //
        // `brain/*/*.md` matched nothing on that machine either, and markdown
        // is not a transcript: the parser refuses anything that is not JSONL.
        common_paths: &[".gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl"],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: NONE,
        environment_override: None,
        environment_roots: NONE,
    },
    crate::sources_editors::CURSOR,
    SourceSpec {
        id: "opencode",
        display_name: "OpenCode",
        tier: 2,
        format: "JSON records or SQLite",
        stability: Stability::Internal,
        // The stored records, not the directory they sit in. `storage` was a
        // bare path, and a bare path is a sweep: the same 5,392-file incident
        // that put globs on Claude Code was waiting under every one of these.
        common_paths: &[
            // `storage/` is opencode's configuration — `project/global.json` and
            // a migration marker. The sessions are in the database, which is
            // also the only thing the parser accepts: it refuses anything that
            // is not native SQLite. Collecting the JSON uploaded a config file
            // on every sync and produced an `unknown_format` artifact each time.
            //
            // opencode names the file in `packages/cli/src/database-path.ts`:
            // `opencode.db` for a released channel, `opencode-<channel>.db`
            // otherwise. Its data directory is XDG_DATA_HOME or
            // `~/.local/share` on every platform (`util/src/global-roots.ts`),
            // so `AppData/Roaming/opencode` was never written on Windows, and
            // `OPENCODE_DATA_DIR` is not a variable opencode reads.
            ".local/share/opencode/opencode.db",
            ".local/share/opencode/opencode-*.db",
        ],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: NONE,
        environment_override: Some("XDG_DATA_HOME"),
        environment_roots: &[".local/share"],
    },
    crate::sources_editors::COPILOT,
    SourceSpec {
        id: "goose",
        display_name: "Goose",
        tier: 2,
        format: "SQLite or legacy JSONL",
        stability: Stability::Internal,
        common_paths: &[
            ".local/share/goose/sessions/sessions.db",
            ".local/share/goose/sessions/*.jsonl",
        ],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: &[
            "AppData/Roaming/Block/goose/data/sessions/*.db",
            "AppData/Roaming/Block/goose/data/sessions/*.jsonl",
        ],
        environment_override: None,
        environment_roots: NONE,
    },
    SourceSpec {
        id: "crush",
        display_name: "Crush",
        tier: 2,
        format: "SQLite",
        stability: Stability::Internal,
        common_paths: &[".crush/crush.db"],
        linux_paths: NONE,
        macos_paths: NONE,
        windows_paths: NONE,
        environment_override: None,
        environment_roots: NONE,
    },
    crate::sources_editors::ROO,
    crate::sources_editors::KILO,
    crate::sources_editors::ZED,
];
