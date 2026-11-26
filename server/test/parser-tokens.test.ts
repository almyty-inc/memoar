import { describe, expect, it } from "vitest";
import type { Session } from "../libs/canonical/src/generated.js";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";
import { buildDatabase } from "./helpers/native-store.js";

/*
  Every session archived before this read `tokenTotals: {input: 0, output: 0}`,
  and every assistant turn the same, because each parser copied the seed's
  zeros onto its turns. These inputs are synthetic and carry usage in the shape
  each tool writes it.
*/

const SEED: SessionSeed = {
  id: "0191cafe-0000-7000-8000-000000000001",
  source: { vendor: "fixture", tool: "fixture", version: "v1", machineId: "0191cafe-0000-7000-8000-000000000002" },
  workspace: { path: "/memoar/no-workspace" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  title: "seeded",
  models: [],
  tokenTotals: { input: 0, output: 0 },
  provenance: [{ kind: "native", capturedAt: "2026-08-01T00:00:00.000Z" }],
  visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-000000000003" },
};

function jsonl(lines: unknown[]): Uint8Array {
  return Buffer.from(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function parseOne(source: string, version: string, raw: Uint8Array): Session {
  const result = new ParserRegistry().parse({ source, version, raw, seed: SEED });
  if (result.kind !== "parsed") throw new Error(result.kind === "unknown" ? result.diagnostic : result.kind);
  return result.sessions[0]!;
}

const uuid = (n: number) => `0191cafe-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("Claude Code usage", () => {
  const usage = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 };
  const assistant = (n: number, id: string, content: unknown, lineUsage: unknown) => ({
    type: "assistant", uuid: uuid(n), parentUuid: uuid(n - 1), sessionId: "s1", cwd: "/workspace/app", timestamp: "2026-08-01T00:00:00.000Z",
    message: { id, role: "assistant", model: "claude-test", content: [content], usage: lineUsage },
  });
  const transcript = jsonl([
    { type: "user", uuid: uuid(1), parentUuid: null, sessionId: "s1", cwd: "/workspace/app", timestamp: "2026-08-01T00:00:00.000Z", message: { role: "user", content: "hello" } },
    // One API response written as three lines, one per content block, each
    // repeating the message id and its usage. The last line's count is final.
    assistant(2, "msg_a", { type: "thinking", thinking: "planning" }, { ...usage, output_tokens: 150 }),
    assistant(3, "msg_a", { type: "text", text: "reading" }, usage),
    assistant(4, "msg_a", { type: "tool_use", id: "call_1", name: "Read", input: {} }, usage),
    { type: "user", uuid: uuid(5), parentUuid: uuid(4), sessionId: "s1", cwd: "/workspace/app", timestamp: "2026-08-01T00:00:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] } },
    assistant(6, "msg_b", { type: "text", text: "done" }, { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 5300, cache_creation_input_tokens: 0 }),
  ]);

  it("counts a response written over several lines once", () => {
    const session = parseOne("claude-code", "v1", transcript);
    const tokens = session.turns.filter((turn) => turn.role === "assistant").map((turn) => turn.tokens);
    expect(tokens).toEqual([
      { input: 10, output: 200, cacheRead: 5000, cacheWrite: 300 },
      { input: 0, output: 0 },
      { input: 0, output: 0 },
      { input: 7, output: 3, cacheRead: 5300 },
    ]);
  });

  it("sums the session's totals over its turns", () => {
    expect(parseOne("claude-code", "v1", transcript).tokenTotals).toEqual({ input: 17, output: 203, cacheRead: 10300, cacheWrite: 300 });
  });
});

describe("Codex usage", () => {
  const count = (last: Record<string, number>, total: Record<string, number>) => ({
    type: "event_msg", payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total, model_context_window: 1000 } },
  });
  const rollout = jsonl([
    { type: "session_meta", payload: { id: "rollout-1", cwd: "/workspace/codex" } },
    { type: "turn_context", payload: { cwd: "/workspace/codex", model: "gpt-test" } },
    { type: "event_msg", payload: { type: "token_count", info: null } },
    { type: "response_item", timestamp: "2026-08-01T00:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] } },
    { type: "response_item", timestamp: "2026-08-01T00:00:02.000Z", payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" } },
    // input_tokens includes cached_input_tokens, which is taken out.
    count({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 20 }, { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 }),
    // The same event again, total unmoved: not counted twice.
    count({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 20 }, { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 }),
    { type: "response_item", timestamp: "2026-08-01T00:00:03.000Z", payload: { type: "function_call_output", call_id: "c1", output: "done" } },
    { type: "response_item", timestamp: "2026-08-01T00:00:04.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "fixed" }] } },
    count({ input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 30 }, { input_tokens: 2200, cached_input_tokens: 1800, output_tokens: 80 }),
    { type: "response_item", timestamp: "2026-08-01T00:00:05.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] } },
    { type: "response_item", timestamp: "2026-08-01T00:00:06.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "welcome" }] } },
    count({ input_tokens: 300, cached_input_tokens: 0, output_tokens: 5, cache_write_input_tokens: 40 }, { input_tokens: 2500, cached_input_tokens: 1800, output_tokens: 85 }),
  ]);

  it("gives each assistant turn the requests that produced it", () => {
    const session = parseOne("codex", "rollout-v1", rollout);
    const assistant = session.turns.filter((turn) => turn.role === "assistant");
    expect(assistant.map((turn) => turn.tokens)).toEqual([
      { input: 400, output: 80, cacheRead: 1800 },
      { input: 300, output: 5, cacheWrite: 40 },
    ]);
    expect(session.tokenTotals).toEqual({ input: 700, output: 85, cacheRead: 1800, cacheWrite: 40 });
  });
});

describe("Antigravity CLI usage", () => {
  it("reads the usage and model each planner step records", () => {
    const transcript = jsonl([
      { step_index: 0, type: "USER_INPUT", source: "USER", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", content: "hi" },
      { step_index: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: "2026-08-01T00:00:01.000Z", content: "looking", model: "gemini-test", input_tokens: 40, cache_read_tokens: 900, output_tokens: 12 },
      { step_index: 2, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: "2026-08-01T00:00:02.000Z", content: "done", input_tokens: 10, cache_read_tokens: 950, output_tokens: 4 },
    ]);
    const session = parseOne("antigravity-cli", "v1", transcript);
    const assistant = session.turns.find((turn) => turn.role === "assistant")!;
    expect(assistant.tokens).toEqual({ input: 50, output: 16, cacheRead: 1850 });
    expect(assistant.model).toBe("gemini-test");
    expect(session.models).toEqual(["gemini-test"]);
    expect(session.tokenTotals).toEqual({ input: 50, output: 16, cacheRead: 1850 });
  });
});

describe("Zed usage", () => {
  it("gives a request's usage to the reply that followed the message that sent it", () => {
    const thread = {
      title: "Usage",
      messages: [
        { User: { id: "u1", content: [{ Text: "first" }] } },
        { Agent: { content: [{ Text: "reply one" }], tool_results: {} } },
        { User: { id: "u2", content: [{ Text: "second" }] } },
        { Agent: { content: [{ Text: "reply two" }], tool_results: {} } },
      ],
      request_token_usage: {
        u1: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 100 },
        u2: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 60 },
      },
    };
    const raw = buildDatabase(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL);",
      [["threads", ["zed-usage", "summary", "2026-08-01T00:00:00.000Z", "json", Buffer.from(JSON.stringify(thread))]]],
    );
    const session = parseOne("zed", "v1", raw);
    expect(session.turns.map((turn) => turn.tokens ?? null)).toEqual([
      null,
      { input: 20, output: 8, cacheRead: 100 },
      null,
      { input: 5, output: 2, cacheWrite: 60 },
    ]);
    expect(session.tokenTotals).toEqual({ input: 25, output: 10, cacheRead: 100, cacheWrite: 60 });
  });
});

describe("a source that records no usage", () => {
  it("keeps zeros rather than inventing a count", () => {
    const transcript = jsonl([
      { step_index: 0, type: "USER_INPUT", source: "USER", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", content: "hi" },
      { step_index: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: "2026-08-01T00:00:01.000Z", content: "hello" },
    ]);
    const session = parseOne("antigravity-cli", "v1", transcript);
    expect(session.tokenTotals).toEqual({ input: 0, output: 0 });
    expect(session.turns.find((turn) => turn.role === "assistant")!.tokens).toEqual({ input: 0, output: 0 });
  });
});
