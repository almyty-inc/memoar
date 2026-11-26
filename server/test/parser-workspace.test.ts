import { describe, expect, it } from "vitest";
import type { Session } from "../libs/canonical/src/generated.js";
import { NO_WORKSPACE, ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";
import type { RawArtifactRecord, TenantContext } from "../src/archive-store.js";
import { DefaultPipelineSeedFactory } from "../src/ingest.js";
import { buildDatabase } from "./helpers/native-store.js";

/*
  A session's workspace used to fall back to the path of the captured file, so
  the web app listed transcript files as projects. These are synthetic inputs
  in each tool's shape, checking that the working directory is read where the
  source records one and that nothing path-like stands in where it does not.
*/

const CONTEXT: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000aa",
  userId: "0191cafe-0000-7000-8000-0000000000bb",
  machineId: "0191cafe-0000-7000-8000-0000000000cc",
  scopes: ["ingest:write"],
  authType: "machine",
};

const TRANSCRIPT_PATH = "/home/someone/.gemini/antigravity-cli/brain/0191cafe-0000-7000-8000-0000000000dd/.system_generated/logs/transcript.jsonl";

function artifact(source: string, sourcePath: string | null): RawArtifactRecord {
  return {
    id: "0191cafe-0000-7000-8000-0000000000ee", tenantId: CONTEXT.tenantId, sessionIds: [], sha256: "a".repeat(64), size: 1,
    objectKey: "k", status: "stored", source, sourcePath, capturedAt: "2026-08-01T00:00:00.000Z", diagnostic: null,
  };
}

function seedFor(source: string, version: string, sourcePath: string | null = TRANSCRIPT_PATH): SessionSeed {
  return new DefaultPipelineSeedFactory().create(CONTEXT, artifact(source, sourcePath), { source, version });
}

function jsonl(lines: unknown[]): Uint8Array {
  return Buffer.from(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function parseOne(source: string, version: string, raw: Uint8Array): Session {
  const result = new ParserRegistry().parse({ source, version, raw, seed: seedFor(source, version) });
  if (result.kind !== "parsed") throw new Error(result.kind === "unknown" ? result.diagnostic : result.kind);
  return result.sessions[0]!;
}

describe("the seed's workspace", () => {
  it("is the no-workspace placeholder, never the captured file's path", () => {
    expect(seedFor("antigravity-cli", "v1").workspace).toEqual({ path: NO_WORKSPACE });
    expect(seedFor("chatgpt-export", "2026-08", "conversations.zip").workspace).toEqual({ path: NO_WORKSPACE });
    expect(seedFor("chatgpt-export", "2026-08", null).workspace).toEqual({ path: NO_WORKSPACE });
  });

  it("stands for a source that records none", () => {
    const session = parseOne("antigravity-cli", "v1", jsonl([
      { step_index: 0, type: "USER_INPUT", source: "USER", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", content: "hi" },
      { step_index: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: "2026-08-01T00:00:01.000Z", content: "hello" },
    ]));
    expect(session.workspace).toEqual({ path: NO_WORKSPACE });
  });
});

describe("Codex workspace", () => {
  const items = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] } },
  ];

  it("is the cwd and repository the session_meta records", () => {
    const session = parseOne("codex", "rollout-v1", jsonl([
      { type: "session_meta", payload: { id: "r1", cwd: "/workspace/codex-app", git: { commit_hash: "0".repeat(40), branch: "feature", repository_url: "https://example.invalid/acme/app.git" } } },
      ...items,
    ]));
    expect(session.workspace).toEqual({ path: "/workspace/codex-app", gitRemote: "https://example.invalid/acme/app.git", branch: "feature" });
  });

  it("falls back to the cwd a turn_context records", () => {
    const session = parseOne("codex", "rollout-v1", jsonl([
      { type: "session_meta", payload: { id: "r2" } },
      { type: "turn_context", payload: { cwd: "/workspace/from-turn", model: "gpt-test" } },
      ...items,
    ]));
    expect(session.workspace).toEqual({ path: "/workspace/from-turn" });
  });
});

describe("Claude Code workspace", () => {
  it("is read from a later line when the first message line names none", () => {
    // A transcript can open with lines that carry no cwd, such as a resumed
    // session's first message written before the working directory was known.
    const session = parseOne("claude-code", "v1", jsonl([
      { type: "summary", summary: "Earlier work", leafUuid: "0191cafe-0000-7000-8000-000000000009" },
      { type: "user", uuid: "0191cafe-0000-7000-8000-000000000010", parentUuid: null, sessionId: "s1", timestamp: "2026-08-01T00:00:00.000Z", message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "0191cafe-0000-7000-8000-000000000011", parentUuid: "0191cafe-0000-7000-8000-000000000010", sessionId: "s1", cwd: "/workspace/later", gitBranch: "main", timestamp: "2026-08-01T00:00:01.000Z", message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ]));
    expect(session.workspace).toEqual({ path: "/workspace/later", branch: "main" });
  });
});

describe("Zed workspace", () => {
  const thread = (snapshot: unknown) => Buffer.from(JSON.stringify({
    title: "Folder",
    messages: [{ User: { id: "u1", content: [{ Text: "hi" }] } }],
    ...(snapshot ? { initial_project_snapshot: snapshot } : {}),
  }));

  it("is the thread's folder where Zed records one", () => {
    const raw = buildDatabase(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL, parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT);",
      [["threads", ["z1", "s", "2026-08-01T00:00:00.000Z", "json", thread(null), null, "/workspace/zed-app\n/workspace/other", "0,1", null]]],
    );
    expect(parseOne("zed", "v1", raw).workspace).toEqual({ path: "/workspace/zed-app" });
  });

  it("falls back to the first worktree of the project snapshot, with its git state", () => {
    const raw = buildDatabase(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL);",
      [["threads", ["z2", "s", "2026-08-01T00:00:00.000Z", "json", thread({
        timestamp: "2026-08-01T00:00:00.000Z",
        worktree_snapshots: [{ worktree_path: "/workspace/snap", git_state: { remote_url: "https://example.invalid/acme/snap.git", current_branch: "dev" } }],
      })]]],
    );
    expect(parseOne("zed", "v1", raw).workspace).toEqual({ path: "/workspace/snap", gitRemote: "https://example.invalid/acme/snap.git", branch: "dev" });
  });
});
