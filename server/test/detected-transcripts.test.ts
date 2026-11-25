import { describe, expect, it } from "vitest";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";
import { FormatDetector } from "../src/ingest/format-detection.js";

/**
 * Real shapes, synthesized, taken through detection and then the parser, the
 * way the pipeline takes an upload from the capture agent: with the bare tool
 * name as the only header. Every value below is invented. The shapes are the
 * ones read off real files on 2026-11-25 (field names and counts only).
 */
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

const AT = "2026-08-01T00:00:00.000Z";

function lines(records: unknown[]): Buffer {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function ingest(source: string, raw: Uint8Array) {
  const format = new FormatDetector().detect(source, raw);
  return { format, result: new ParserRegistry().parse({ ...format, raw, seed: SEED }) };
}

describe("antigravity-cli as the CLI writes it", () => {
  it("keeps a session that is one question and no reply", () => {
    // 514 of 655 transcripts on the machine checked are exactly this: the CLI
    // logged the prompt and the session ended. It is a one-turn session, not
    // an error, so it is archived as one.
    const { format, result } = ingest("antigravity-cli", lines([
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: AT, content: "rename the module" },
    ]));
    expect(format).toEqual({ source: "antigravity-cli", version: "v1" });
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions[0]!.turns.map((turn) => turn.role)).toEqual(["user"]);
  });

  it("reads tool output written as GENERIC steps and keeps errors and system messages", () => {
    const { result } = ingest("antigravity-cli", lines([
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: AT, content: "list the files" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: AT, input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }] },
      { step_index: 2, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", created_at: AT, error: "API error (attempt 1): transport error" },
      { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", created_at: AT, content: "Created At: 2026-08-01T00:00:00Z\nOutput: a.ts" },
      { step_index: 4, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: AT, content: "The following is a <SYSTEM_MESSAGE>" },
      { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: AT, content: "There is one file." },
    ]));
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    const turns = result.sessions[0]!.turns;
    // The retry notice is an error the person saw and the system message is
    // context the model was given. Both were dropped. They are kept as an
    // error block and a system turn, in the order they happened.
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "system", "assistant"]);
    expect(turns[1]!.blocks.map((block) => block.kind)).toEqual(["tool_call", "error", "tool_result"]);
    expect(turns[1]!.blocks[2]!.callId).toBe(turns[1]!.blocks[0]!.callId);
    expect(turns[3]!.blocks.map((block) => block.kind)).toEqual(["text"]);
  });

  it("is still recognised when its first line is damaged", () => {
    const raw = Buffer.concat([
      Buffer.from('{"step_index":0,"source":"USER_EXPL\n'),
      lines([{ step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: AT, content: "again" }]),
    ]);
    const { format, result } = ingest("antigravity-cli", raw);
    expect(format.version).toBe("v1");
    expect(result.kind).toBe("parsed");
  });
});

describe("codex rollouts as they reached the archive", () => {
  const meta = { timestamp: AT, type: "session_meta", payload: { id: "rollout-1", cwd: "/workspace" } };
  const item = (payload: unknown) => ({ timestamp: AT, type: "response_item", payload });

  it("keeps a rollout that has a few lines broken by redaction", () => {
    // The capture agent before 2026-09-19 redacted a home path through the
    // backslash of an escaped quote. Eight rollouts on dev, 1 to 22 broken
    // lines each, were refused whole.
    const good = lines([
      meta,
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "why?" }] }),
    ]);
    const broken = Buffer.from('{"timestamp":"2026-08-01T00:00:00.000Z","type":"response_item","payload":{"type":"function_call_output","output":"{\\"path\\":\\"/home/[REDACTED_USER]",\\"size\\":1}"}}\n');
    const tail = lines([item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "because" }] })]);
    const { format, result } = ingest("codex", Buffer.concat([good, broken, tail]));
    expect(format.version).toBe("rollout-v1");
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions[0]!.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  it("reports a guardian thread that holds only an encrypted compaction as empty", () => {
    // The two newer refusals on dev: session_meta, one `compaction` item whose
    // only content is `encrypted_content`, and a settings event. There is no
    // message in it, so no session, and nothing went unread either: it is
    // empty, not a parse failure for `memoar doctor` to count.
    const { result } = ingest("codex", lines([
      meta,
      item({ type: "compaction", id: "cmp_1", encrypted_content: "b3BhcXVl" }),
      { timestamp: AT, type: "event_msg", payload: { type: "thread_settings_applied", thread_id: "t" } },
    ]));
    expect(result.kind).toBe("empty");
    if (result.kind !== "empty") return;
    expect(result.diagnostic).toContain("only compactions");
  });
});

describe("the other text formats the agent uploads without a version", () => {
  const task = [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: "hello" }];
  const envelope = { sessionId: "panel-1", version: 3, requests: [] };

  it.each([
    ["roo", Buffer.from(JSON.stringify(task)), "v1"],
    ["kilo", Buffer.from(JSON.stringify(task)), "v1"],
    ["copilot", Buffer.from(JSON.stringify(envelope)), "v1"],
    ["copilot", lines([{ kind: 0, v: envelope }]), "v1"],
  ] as const)("detects %s", (source, raw, version) => {
    expect(new FormatDetector().detect(source, raw)).toEqual({ source, version });
  });

  it.each([
    ["claude-code", "markdown memory", Buffer.from("# Project notes\n\n- keep files small\n")],
    ["claude-code", "an audit key", Buffer.from("k3y-material-that-is-not-real\n")],
    ["claude-code", "desktop settings", Buffer.from(JSON.stringify({ numStartups: 3, userID: "0000" }))],
    ["claude-code", "a git index", Buffer.from([0x44, 0x49, 0x52, 0x43, 0, 0, 0, 2])],
    ["antigravity-cli", "a markdown plan", Buffer.from("# Plan\n")],
    ["codex", "a config file", Buffer.from('model = "example"\n')],
  ] as const)("does not call %s %s a session", (source, _what, raw) => {
    expect(new FormatDetector().detect(source, raw).version).toBe("unknown");
  });
});
