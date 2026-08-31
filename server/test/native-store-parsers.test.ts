import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";

const SEED: SessionSeed = {
  id: "0191cafe-0000-7000-8000-000000000001",
  source: { vendor: "fixture", tool: "fixture", version: "v1", machineId: "0191cafe-0000-7000-8000-000000000002" },
  workspace: { path: "/workspace/seeded" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  title: "seeded",
  models: [],
  tokenTotals: { input: 0, output: 0 },
  provenance: [{ kind: "native", capturedAt: "2026-08-01T00:00:00.000Z" }],
  visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-000000000003" },
};

function parse(source: string, raw: Uint8Array, version = "v1") {
  return new ParserRegistry().parse({ source, version, raw, seed: SEED });
}

/** Every one of these stores lives in SQLite, so a non-database upload is the
 * first thing a user can get wrong. */
describe.each(["opencode", "copilot", "zed", "warp", "windsurf"])("%s", (source) => {
  it("refuses bytes that are not a database, keeping them for later", () => {
    const raw = Buffer.from("this is plainly not SQLite");
    const result = parse(source, raw);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("SQLite");
    expect(Buffer.from(result.raw)).toEqual(raw);
  });
});

describe("zed", () => {
  function threadDatabase(thread: unknown, dataType = "zstd"): Uint8Array {
    // Built with the same tooling the fixture uses, so these exercise the real
    // read path rather than a stand-in for it.
    const payload = JSON.stringify(thread);
    const blob = dataType === "zstd" ? zstdCompressSync(Buffer.from(payload)) : Buffer.from(payload);
    return buildDatabase(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL);",
      [["threads", ["zed-x", "summary", "2026-08-01T00:00:00.000Z", dataType, blob]]],
    );
  }

  it("reads an uncompressed thread as well as a compressed one", () => {
    // data_type names the encoding; a thread stored plainly must not be
    // refused just because the common case is compressed.
    const thread = { title: "Plain", messages: [{ User: { id: "m1", content: [{ Text: "hello" }] } }] };
    const result = parse("zed", threadDatabase(thread, "none"));
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions[0]!.turns[0]!.blocks[0]!.text).toBe("hello");
  });

  it("maps each tagged content variant onto its block kind", () => {
    const thread = {
      title: "Variants",
      model: "claude-sonnet",
      messages: [{
        Agent: {
          id: "m1",
          content: [
            { Thinking: "weighing it up" },
            { ToolUse: { id: "call-1", name: "read_file", input: { path: "a.ts" } } },
            { Text: "done" },
            { SomethingZedAddedLater: { unknown: true } },
          ],
        },
      }],
    };
    const result = parse("zed", threadDatabase(thread));
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    const blocks = result.sessions[0]!.turns[0]!.blocks;
    // An unrecognised variant is skipped rather than failing the thread: Zed
    // will add variants, and losing a transcript to one is far worse.
    expect(blocks.map((block) => block.kind)).toEqual(["thinking", "tool_call", "text"]);
    expect(blocks[1]!.name).toBe("read_file");
    expect(blocks[1]!.callId).toBe("call-1");
    expect(result.sessions[0]!.models).toEqual(["claude-sonnet"]);
    expect(result.sessions[0]!.turns[0]!.role).toBe("assistant");
  });

  it("skips a message that carries no readable content", () => {
    const thread = { title: "Empty", messages: [{ User: { id: "m1", content: [] } }, { User: { id: "m2", content: [{ Text: "kept" }] } }] };
    const result = parse("zed", threadDatabase(thread));
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    const turns = result.sessions[0]!.turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.ordinal).toBe(0);
    expect(turns[0]!.parentId).toBeNull();
  });

  it("reports a thread whose payload has no messages", () => {
    const result = parse("zed", threadDatabase({ title: "Broken" }));
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("no messages array");
  });
});

describe("opencode", () => {
  it("reports a database with no sessions instead of returning nothing", () => {
    const raw = buildDatabase(
      "CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL);"
      + "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);"
      + "CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);",
      [],
    );
    const result = parse("opencode", raw);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("no sessions");
  });
});

describe("copilot", () => {
  it("reports a store with no sessions", () => {
    const raw = buildDatabase(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);"
      + "CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT, timestamp TEXT);",
      [],
    );
    const result = parse("copilot", raw);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("no sessions");
  });

  it("keeps a half-finished exchange rather than dropping the whole row", () => {
    // A question the model never answered is still part of the transcript.
    const raw = buildDatabase(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);"
      + "CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT, timestamp TEXT);",
      [
        ["sessions", ["s1", null, null, null, null, null, "2026-08-01T00:00:00.000Z", null]],
        ["turns", [1, "s1", 0, "only a question", null, null]],
      ],
    );
    const result = parse("copilot", raw);
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    const session = result.sessions[0]!;
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]!.role).toBe("user");
    // With no summary or cwd recorded, the seed's values stand.
    expect(session.title).toBe("seeded");
    expect(session.workspace.path).toBe("/workspace/seeded");
  });
});

describe("pi-agent", () => {
  function log(lines: unknown[]): Uint8Array {
    return Buffer.from(lines.map((line) => JSON.stringify(line)).join("\n"));
  }

  it("ignores event types it does not recognise", () => {
    const result = new ParserRegistry().parse({
      source: "pi-agent",
      version: "v1",
      seed: SEED,
      raw: log([
        { type: "event", event: "session_start", sessionId: "pi-1", title: "Titled" },
        { type: "event", event: "telemetry_flush", at: "2026-08-01T00:00:00.000Z" },
        { type: "event", event: "message", id: "m1", role: "user", at: "2026-08-01T00:00:00.000Z", payload: { parts: [{ id: "b1", kind: "text", text: "hello" }] } },
      ]),
    });
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions[0]!.turns).toHaveLength(1);
    expect(result.sessions[0]!.title).toBe("Titled");
    expect(result.sessions[0]!.source.nativeSessionId).toBe("pi-1");
  });

  it("reports a log with no message events", () => {
    const result = new ParserRegistry().parse({
      source: "pi-agent",
      version: "v1",
      seed: SEED,
      raw: log([{ type: "event", event: "session_start", sessionId: "pi-1" }]),
    });
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("no message events");
  });

  it("refuses bytes that are not JSON lines", () => {
    const result = new ParserRegistry().parse({ source: "pi-agent", version: "v1", seed: SEED, raw: Buffer.from("{not json") });
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("JSON lines");
  });
});

/** Builds a real SQLite file with the given schema and rows, and returns its bytes. */
function buildDatabase(schema: string, rows: [string, unknown[]][]): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "memoar-parser-test-"));
  const path = join(directory, "native.sqlite3");
  try {
    const database = new DatabaseSync(path);
    try {
      database.exec(schema);
      for (const [table, values] of rows) {
        database
          .prepare(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`)
          .run(...(values as (string | number | null | Uint8Array)[]));
      }
    } finally {
      database.close();
    }
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("cursor", () => {
  function cursorDatabase(rows: [string, unknown][]): Uint8Array {
    return buildDatabase(
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
      rows.map(([key, value]) => ["cursorDiskKV", [key, JSON.stringify(value)]] as [string, unknown[]]),
    );
  }

  it("reads turns from the bubble rows the header index points at", () => {
    // composerData holds the ordered index; the turns themselves are separate
    // bubbleId rows. Reading composerData alone found the index and never the
    // content, because the conversation is not stored there.
    const raw = cursorDatabase([
      ["composerData:c1", {
        composerId: "c1",
        name: "Titled",
        createdAt: 1785661200000,
        fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 2 }],
      }],
      ["bubbleId:c1:b1", { type: 1, text: "why?" }],
      ["bubbleId:c1:b2", { type: 2, text: "because", allThinkingBlocks: [{ text: "weighing it" }], toolResults: [{ toolCallId: "call_1", result: "output" }] }],
    ]);
    const result = parse("cursor", raw, "v3");
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    const session = result.sessions[0]!;
    expect(session.title).toBe("Titled");
    expect(session.source.nativeSessionId).toBe("c1");
    expect(session.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(session.turns[1]!.blocks.map((block) => block.kind)).toEqual(["thinking", "text", "tool_result"]);
    expect(session.turns[1]!.parentId).toBe("b1");
    expect(session.turns[0]!.createdAt).toBe("2026-08-02T09:00:00.000Z");
  });

  it("keeps the conversation when a bubble the index names is missing", () => {
    // Bubbles can be pruned independently of the index; losing one must not
    // lose the turns around it.
    const raw = cursorDatabase([
      ["composerData:c1", { composerId: "c1", fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }, { bubbleId: "gone", type: 2 }, { bubbleId: "b3", type: 1 }] }],
      ["bubbleId:c1:b1", { type: 1, text: "first" }],
      ["bubbleId:c1:b3", { type: 1, text: "third" }],
    ]);
    const result = parse("cursor", raw, "v3");
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    const turns = result.sessions[0]!.turns;
    expect(turns.map((turn) => turn.blocks[0]!.text)).toEqual(["first", "third"]);
    expect(turns.map((turn) => turn.ordinal)).toEqual([0, 1]);
    expect(turns[1]!.parentId).toBe("b1");
  });

  it("reports a database with no composer rows", () => {
    const result = parse("cursor", cursorDatabase([["someOtherKey", { unrelated: true }]]), "v3");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("no composerData rows");
  });
});
