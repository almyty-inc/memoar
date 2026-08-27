import { describe, expect, it } from "vitest";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";

const SEED: SessionSeed = {
  id: "0191cafe-0000-7000-8000-000000000001",
  source: { vendor: "fixture", tool: "fixture", version: "v1", machineId: "0191cafe-0000-7000-8000-000000000002" },
  workspace: { path: "/workspace/seeded" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  title: "seeded",
  models: ["seed-model"],
  tokenTotals: { input: 0, output: 0 },
  provenance: [{ kind: "native", capturedAt: "2026-08-01T00:00:00.000Z" }],
  visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-000000000003" },
};

function lines(records: unknown[]): Uint8Array {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function parse(source: string, version: string, raw: Uint8Array) {
  return new ParserRegistry().parse({ source, version, raw, seed: SEED });
}

describe("claude-code transcripts", () => {
  it("skips the bookkeeping a real transcript is interleaved with", () => {
    // A real session carries eleven record types; only user and assistant are
    // messages. Requiring uuid and message on every line refused whole files.
    const raw = lines([
      { type: "last-prompt", prompt: "irrelevant" },
      { type: "file-history-snapshot", files: [] },
      { type: "user", uuid: "0191cafe-0000-7000-8000-00000000000b", parentUuid: null, timestamp: "2026-08-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "attachment", data: {} },
      { type: "ai-title", title: "Generated" },
      { type: "assistant", uuid: "0191cafe-0000-7000-8000-00000000000c", parentUuid: "0191cafe-0000-7000-8000-00000000000b", timestamp: "2026-08-01T00:00:00.000Z", message: { role: "assistant", model: "claude-sonnet", content: [{ type: "text", text: "hi" }] } },
      { type: "queue-operation", op: "flush" },
    ]);
    const result = parse("claude-code", "v1", raw);
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    const turns = result.sessions[0]!.turns;
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(turns[1]!.parentId).toBe(turns[0]!.id);
    expect(turns[1]!.model).toBe("claude-sonnet");
  });

  it("records a tool call as a tool call, not as prose", () => {
    // Anthropic names this block tool_use. Unmapped, it fell through to text
    // with a note about its real kind — 1,480 times in one real session, so
    // every tool call in the archive read as something the model said.
    const raw = lines([
      {
        type: "assistant",
        uuid: "0191cafe-0000-7000-8000-00000000000c",
        parentUuid: null,
        timestamp: "2026-08-01T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "considering", text: "considering" },
            { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "a.ts" } },
            { type: "image", source: { type: "base64" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "0191cafe-0000-7000-8000-00000000000d",
        parentUuid: "0191cafe-0000-7000-8000-00000000000c",
        timestamp: "2026-08-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", text: "ok" }] },
      },
    ]);
    const result = parse("claude-code", "v1", raw);
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    const blocks = result.sessions[0]!.turns.flatMap((turn) => turn.blocks);
    expect(blocks.map((block) => block.kind)).toEqual(["thinking", "tool_call", "attachment", "tool_result"]);
    const call = blocks[1]!;
    expect(call.name).toBe("Read");
    expect(call.callId).toBe("toolu_01");
    expect(call.data).toEqual({ file_path: "a.ts" });
    expect(blocks[3]!.callId).toBe("toolu_01");
  });

  it("gives every block a distinct id across a long transcript", () => {
    // Block ids were derived from neighbouring record uuids, whose ranges met:
    // 802 duplicates in a 4,369-turn session.
    const raw = lines(Array.from({ length: 40 }, (_, index) => ({
      type: index % 2 === 0 ? "user" : "assistant",
      uuid: `0191cafe-0000-7000-8000-${(0x100 + index).toString(16).padStart(12, "0")}`,
      parentUuid: null,
      timestamp: "2026-08-01T00:00:00.000Z",
      message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `line ${index}` }, { type: "text", text: `more ${index}` }] },
    })));
    const result = parse("claude-code", "v1", raw);
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    const session = result.sessions[0]!;
    const ids = session.turns.flatMap((turn) => [turn.id, ...turn.blocks.map((block) => block.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports a file that holds no messages at all", () => {
    const result = parse("claude-code", "v1", lines([{ type: "file-history-snapshot", files: [] }]));
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("no message records");
  });
});

describe("codex rollouts", () => {
  function rollout(items: unknown[]): Uint8Array {
    return lines([
      { timestamp: "2026-08-01T00:00:00.000Z", type: "session_meta", payload: { id: "rollout-1", cwd: "/workspace" } },
      { timestamp: "2026-08-01T00:00:00.000Z", type: "turn_context", payload: {} },
      ...items.map((payload) => ({ timestamp: "2026-08-01T00:00:00.000Z", type: "response_item", payload })),
    ]);
  }

  it("gathers reasoning and tool activity into the assistant turn they belong to", () => {
    // Every response item used to become its own turn, defaulting to the user
    // role: a real rollout read as 762 turns of which 740 were empty.
    const result = parse("codex", "rollout-v1", rollout([
      { type: "message", role: "user", content: [{ type: "input_text", text: "why?" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "weighing it" }] },
      { type: "function_call", name: "shell", call_id: "call_1", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "call_1", output: "a.ts" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "because" }] },
    ]));
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    const turns = result.sessions[0]!.turns;
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(turns[1]!.blocks.map((block) => block.kind)).toEqual(["thinking", "tool_call", "tool_result", "text"]);
    expect(turns[1]!.blocks[1]!.data).toEqual({ command: "ls" });
    expect(turns.every((turn) => turn.blocks.length > 0)).toBe(true);
  });

  it("keeps the rollout id as the native id, not as the archive's own", () => {
    // The rollout id names the session in Codex. Putting it in the canonical id
    // field also meant doing arithmetic on it, which throws unless it is hex.
    const result = parse("codex", "rollout-v1", rollout([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]));
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions[0]!.id).toBe(SEED.id);
    expect(result.sessions[0]!.source.nativeSessionId).toBe("rollout-1");
  });

  it("ignores item types this build has never seen", () => {
    const result = parse("codex", "rollout-v1", rollout([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "something_codex_added_later", detail: "unknown" },
    ]));
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions[0]!.turns).toHaveLength(1);
  });

  it("reports a rollout whose items carry nothing readable", () => {
    const result = parse("codex", "rollout-v1", rollout([{ type: "reasoning", summary: [] }]));
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("no readable messages");
  });
});

describe("antigravity-cli transcripts", () => {
  it("reads the step log the CLI writes, in step order", () => {
    // The CLI writes a log of steps, not of messages, and does not write them
    // in order: a real transcript had step 3 on the line before step 2. The
    // parser required message records with id and parts, which the CLI has
    // never written, so it refused every real transcript.
    const raw = lines([
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", content: "why?" },
      { step_index: 1, source: "SYSTEM", type: "CONVERSATION_HISTORY", status: "DONE", created_at: "2026-08-01T00:00:00.000Z" },
      { step_index: 3, source: "MODEL", type: "VIEW_FILE", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", content: "file contents" },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", thinking: "weighing it", tool_calls: [{ name: "view_file", args: { AbsolutePath: "/a.ts" } }] },
      { step_index: 4, source: "SYSTEM", type: "CHECKPOINT", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", content: "{{ CHECKPOINT 0 }}" },
      { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", content: "because" },
    ]);
    const result = parse("antigravity-cli", "v1", raw);
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    const turns = result.sessions[0]!.turns;
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    // Step 2 precedes step 3 despite the file order, so the reasoning and the
    // call come before the result they produced.
    expect(turns[1]!.blocks.map((block) => block.kind)).toEqual(["thinking", "tool_call", "tool_result", "text"]);
    expect(turns[1]!.blocks[1]!.name).toBe("view_file");
    expect(turns[1]!.blocks[1]!.data).toEqual({ AbsolutePath: "/a.ts" });
  });

  it("ignores the CLI's own bookkeeping and unfamiliar step types", () => {
    const raw = lines([
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", content: "hello" },
      { step_index: 1, source: "SYSTEM", type: "SOMETHING_ADDED_LATER", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", content: "opaque" },
    ]);
    const result = parse("antigravity-cli", "v1", raw);
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions[0]!.turns).toHaveLength(1);
  });

  it("reports a transcript with no readable steps", () => {
    const raw = lines([{ step_index: 0, source: "SYSTEM", type: "CHECKPOINT", status: "DONE", created_at: "2026-08-01T00:00:00.000Z", content: "marker" }]);
    const result = parse("antigravity-cli", "v1", raw);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("no readable steps");
  });
});
