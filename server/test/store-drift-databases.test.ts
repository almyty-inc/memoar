import { describe, expect, it } from "vitest";
import { buildDatabase, ingest } from "./helpers/native-store.js";

/**
 * Stores that moved to a new database layout. Every input here is synthetic:
 * the table and column names are the tools' own, read from their published
 * schema, and the content is made up.
 */

const V1 = `
  CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`;
const V2 = `
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
  CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT, time_created INTEGER, data TEXT);`;

const model = JSON.stringify({ id: "model-b", providerID: "provider" });
const v2User = ["msg_2", "ses_1", "user", 2, 2000, JSON.stringify({ text: "second question", time: { created: 2000 } })];
const v2Assistant = ["msg_3", "ses_1", "assistant", 3, 3000, JSON.stringify({
  model: { id: "model-b", providerID: "provider" },
  tokens: { input: 7, output: 9 },
  content: [
    { type: "reasoning", text: "thinking about the second question" },
    { type: "tool", id: "call_1", name: "bash", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "listing output" }] } },
    { type: "text", text: "second answer" },
  ],
})];

describe("opencode mid-migration", () => {
  it("reads v1 and takes from v2 every message v1 does not have", () => {
    const raw = buildDatabase(V1 + V2, [
      ["session", ["ses_1", "Title", "/work/a", null]],
      ["message", ["msg_1", "ses_1", 1000, JSON.stringify({ role: "user" })]],
      ["part", ["prt_1", "msg_1", "ses_1", 1000, JSON.stringify({ type: "text", text: "first question" })]],
      ["session_v2", ["ses_1", "Title", "/work/a", model]],
      ["session_message", ["msg_1", "ses_1", "user", 1, 1000, JSON.stringify({ text: "first question" })]],
      ["session_message", v2User],
      ["session_message", v2Assistant],
    ]);
    const { format, result } = ingest("opencode", raw);
    expect(format.version).toBe("v1");
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    const [session] = result.sessions;
    expect(session!.turns.map((turn) => turn.role)).toEqual(["user", "user", "assistant"]);
    const texts = session!.turns.flatMap((turn) => turn.blocks.map((block) => block.text));
    expect(texts).toEqual(["first question", "second question", "thinking about the second question", undefined, "listing output", "second answer"]);
    expect(session!.turns[2]!.model).toBe("model-b");
    expect(session!.turns[2]!.tokens).toEqual({ input: 7, output: 9 });
    expect(session!.models).toEqual(["model-b"]);
  });

  it("reads a session that exists only in v2, with parts in session_part", () => {
    const raw = buildDatabase(V2, [
      ["session_v2", ["ses_9", "Only v2", "/work/b", model]],
      ["session_message", ["msg_1", "ses_9", "user", 1, 1000, JSON.stringify({ text: "hello" })]],
      ["session_message", ["msg_2", "ses_9", "assistant", 2, 2000, JSON.stringify({ model: { id: "model-c", providerID: "p" }, content: [] })]],
      ["session_part", ["msg_2", "ses_9", 0, "text", null, 2000, JSON.stringify({ type: "text", text: "streamed part" })]],
    ]);
    const { result } = ingest("opencode", raw);
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    const [session] = result.sessions;
    expect(session!.title).toBe("Only v2");
    expect(session!.turns.map((turn) => turn.blocks[0]?.text)).toEqual(["hello", "streamed part"]);
    expect(session!.models).toEqual(["model-c", "model-b"]);
  });
});

describe("kilo", () => {
  it("reads kilo.db, opencode's schema, through the bare tool name", () => {
    const raw = buildDatabase(V1, [
      ["session", ["ses_k", "Kilo task", "/work/k", null]],
      ["message", ["msg_1", "ses_k", 1000, JSON.stringify({ role: "user" })]],
      ["part", ["prt_1", "msg_1", "ses_k", 1000, JSON.stringify({ type: "text", text: "make it work" })]],
      ["message", ["msg_2", "ses_k", 2000, JSON.stringify({ role: "assistant", modelID: "model-k", providerID: "kilo" })]],
      ["part", ["prt_2", "msg_2", "ses_k", 2000, JSON.stringify({ type: "text", text: "done" })]],
    ]);
    const { format, result } = ingest("kilo", raw);
    expect(format).toEqual({ source: "kilo", version: "v1" });
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.parser).toMatch(/^kilo:v1:/u);
    expect(result.sessions[0]!.turns.map((turn) => turn.blocks[0]!.text)).toEqual(["make it work", "done"]);
    expect(result.sessions[0]!.models).toEqual(["model-k"]);
  });

  it("still reads the legacy task JSON", () => {
    const raw = Buffer.from(JSON.stringify([{ role: "user", content: "legacy task" }, { role: "assistant", content: "ok" }]));
    const { format, result } = ingest("kilo", raw);
    expect(format.version).toBe("v1");
    expect(result.kind).toBe("parsed");
  });
});

describe("goose", () => {
  it("names the session's model from model_config_json", () => {
    const raw = buildDatabase(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, description TEXT, working_dir TEXT, created_at TEXT, model_config_json TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, message_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER);`, [
      ["sessions", ["g1", "n", "Goose task", "/work/g", "2026-01-01", JSON.stringify({ model_name: "model-g", context_limit: 1000 })]],
      ["messages", [1, "g1", "0191cafe-0000-7000-8000-0000000000a1", "user", JSON.stringify([{ type: "text", text: "hi" }]), 1767225600]],
    ]);
    const { result } = ingest("goose", raw);
    if (result.kind !== "parsed") throw new Error(result.kind === "unknown" ? result.diagnostic : result.kind);
    expect(result.sessions[0]!.models).toEqual(["model-g"]);
  });
});

describe("cursor 3.x", () => {
  const SCHEMA = "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);";

  it("dates and attributes each bubble, and titles from composerHeaders", () => {
    const raw = buildDatabase(SCHEMA, [
      ["cursorDiskKV", ["composerData:c1", JSON.stringify({ composerId: "c1", createdAt: 1767225600000, fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 2 }] })]],
      ["cursorDiskKV", ["bubbleId:c1:b1", JSON.stringify({ type: 1, text: "question", createdAt: "2026-01-01T00:00:05.000Z" })]],
      ["cursorDiskKV", ["bubbleId:c1:b2", JSON.stringify({ type: 2, text: "answer", createdAt: "2026-01-01T00:00:09.000Z", modelInfo: { modelName: "model-x" } })]],
      ["ItemTable", ["composer.composerHeaders", JSON.stringify({ allComposers: [{ composerId: "c1", name: "Header title" }] })]],
    ]);
    const { result } = ingest("cursor", raw);
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    const [session] = result.sessions;
    expect(session!.title).toBe("Header title");
    expect(session!.turns.map((turn) => turn.createdAt)).toEqual(["2026-01-01T00:00:05.000Z", "2026-01-01T00:00:09.000Z"]);
    expect(session!.turns[1]!.model).toBe("model-x");
    expect(session!.models).toEqual(["model-x"]);
  });

  it("keeps the bubbles of a composer that has no index, in written order", () => {
    const raw = buildDatabase(SCHEMA, [
      ["cursorDiskKV", ["composerData:c2", JSON.stringify({ composerId: "c2", name: "No index" })]],
      ["cursorDiskKV", ["bubbleId:c2:z", JSON.stringify({ type: 2, text: "later reply", createdAt: "2026-01-01T00:01:00.000Z" })]],
      ["cursorDiskKV", ["bubbleId:c2:a", JSON.stringify({ type: 1, text: "earlier ask", createdAt: "2026-01-01T00:00:00.000Z" })]],
    ]);
    const { result } = ingest("cursor", raw);
    if (result.kind !== "parsed") throw new Error(result.kind === "unknown" ? result.diagnostic : result.kind);
    expect(result.sessions[0]!.turns.map((turn) => [turn.role, turn.blocks[0]!.text])).toEqual([["user", "earlier ask"], ["assistant", "later reply"]]);
  });
});
