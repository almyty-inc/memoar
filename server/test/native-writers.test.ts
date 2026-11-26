import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConversionEngine } from "../src/convert.js";
import { TARGET_VERSIONS } from "../src/convert/target-versions.js";
import type { ConversionBundle } from "../src/convert/types.js";
import { claudeShapedSession, codexShapedSession } from "./fixtures/conversion-sessions.js";

const engine = new ConversionEngine();
const HERE = "/private/tmp/resume-here";

interface Part { type: string; id?: string; tool_use_id?: string; input?: unknown; image_url?: string; [key: string]: unknown }
interface Item { type: string; role?: string; content?: Part[]; call_id?: string; output?: string; arguments?: string; [key: string]: unknown }
interface Line {
  type: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  message: { role: string; id: string; content: Part[] };
  payload: Item;
  [key: string]: unknown;
}

function lines(bundle: ConversionBundle): Line[] {
  return Buffer.from(bundle.files[0]!.bytes).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Line);
}

/**
 * The fields Claude Code needs to treat a line as conversation. A file of
 * lines whose content blocks were canonical (`{"kind":"text"}`) resumed as an
 * empty conversation, which is the defect these tests pin.
 */
describe("the Claude Code writer", () => {
  const bundle = engine.convert(codexShapedSession(), "claude-code", "fail", undefined, { workspacePath: HERE });
  const records = lines(bundle);

  it("writes every line in Claude Code's record shape", () => {
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record).toMatchObject({
        isSidechain: false, userType: "external", cwd: HERE, sessionId: bundle.sessionId, version: TARGET_VERSIONS["claude-code"],
      });
      expect(["user", "assistant"]).toContain(record.type);
      expect(record.message.role).toBe(record.type);
      expect(typeof record.uuid).toBe("string");
      expect(typeof record.timestamp).toBe("string");
      for (const block of record.message.content) {
        expect(["text", "image", "document", "thinking", "redacted_thinking", "tool_use", "tool_result"]).toContain(block.type);
        expect(block).not.toHaveProperty("kind");
      }
    }
    for (const record of records.filter((line) => line.type === "assistant")) {
      expect(record.message).toMatchObject({ type: "message", role: "assistant", stop_sequence: null });
      expect(record.message.id).toMatch(/^msg_/u);
    }
  });

  it("chains the lines so --resume walks back from the last one to the first", () => {
    expect(records[0]!.parentUuid).toBeNull();
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index]!.parentUuid).toBe(records[index - 1]!.uuid);
    }
    expect(new Set(records.map((record) => record.uuid)).size).toBe(records.length);
  });

  it("answers every tool call in the next message, with the call's id", () => {
    records.forEach((record, index) => {
      const calls = record.message.content.filter((block) => block.type === "tool_use");
      if (!calls.length) return;
      const next = records[index + 1]!;
      expect(next.type).toBe("user");
      const answered = next.message.content.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id);
      expect(answered).toEqual(calls.map((call) => call.id));
      for (const call of calls) expect(typeof call.input).toBe("object");
    });
    const unanswered = bundle.report.degraded.find((entry) => entry.kind === "tool_call");
    expect(unanswered?.reason).toMatch(/No result was recorded/u);
  });

  it("leaves out the source harness and another vendor's reasoning, and says so", () => {
    const text = JSON.stringify(records);
    expect(text).not.toContain("AGENTS.md");
    expect(text).not.toContain("environment_context");
    expect(text).not.toContain("Developer instructions");
    expect(text).not.toContain("Compaction summary");
    expect(text).not.toContain("opaque-ciphertext");
    expect(bundle.report.dropped.map((entry) => entry.reason)).toEqual(expect.arrayContaining(["source_harness_context", "reasoning_not_portable"]));
    expect(records[0]!.message.content[0]).toEqual({ type: "text", text: "List the fixtures and tell me which one is largest." });
    expect(records[0]!.message.content[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
  });

  it("keeps Claude's own signed thinking when the source is Claude Code", () => {
    const claude = lines(engine.convert(claudeShapedSession(), "claude-code", "fail"));
    expect(claude[1]!.message.content[0]).toEqual({ type: "thinking", thinking: "I should read the file.", signature: "sig-test" });
  });

  it("places the session for the directory it will be resumed in", () => {
    expect(bundle.files[0]!.path).toBe(`~/.claude/projects/-private-tmp-resume-here/${bundle.sessionId}.jsonl`);
    const archived = engine.convert(codexShapedSession(), "claude-code", "fail");
    expect(archived.files[0]!.path).toContain("/-workspace-source-project/");
    expect(lines(archived)[0]).toMatchObject({ cwd: "/workspace/source-project", gitBranch: "main" });
  });
});

describe("the Codex writer", () => {
  const bundle = engine.convert(claudeShapedSession(), "codex", "fail", undefined, { workspacePath: HERE });
  const records = lines(bundle);
  const items = records.filter((record) => record.type === "response_item").map((record) => record.payload);

  it("opens with session_meta naming the session and the directory", () => {
    expect(records[0]).toMatchObject({
      type: "session_meta",
      payload: { id: bundle.sessionId, cwd: HERE, cli_version: TARGET_VERSIONS.codex, originator: "memoar" },
    });
    expect(bundle.files[0]!.path).toMatch(new RegExp(`^~/\\.codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-${bundle.sessionId}\\.jsonl$`, "u"));
  });

  it("writes Responses API items, not canonical blocks", () => {
    for (const item of items) {
      expect(["message", "function_call", "function_call_output", "reasoning"]).toContain(item.type);
      if (item.type !== "message") continue;
      expect(["user", "assistant"]).toContain(item.role);
      for (const part of item.content ?? []) {
        expect(item.role === "assistant" ? ["output_text"] : ["input_text", "input_image"]).toContain(part.type);
      }
    }
    expect(items.find((item) => item.type === "message")).toEqual({
      type: "message", role: "user", content: [{ type: "input_text", text: "Read the config and say which port it uses." }],
    });
    expect(items.flatMap((item) => item.content ?? []).find((part) => part.type === "input_image")?.image_url)
      .toMatch(/^data:image\/png;base64,/u);
  });

  it("follows every function call with its output", () => {
    const calls = items.filter((item) => item.type === "function_call");
    expect(calls).toEqual([{ type: "function_call", name: "Read", arguments: JSON.stringify({ file_path: "/workspace/source-project/config.toml" }), call_id: "toolu_read" }]);
    const outputIndex = items.findIndex((item) => item.type === "function_call_output" && item.call_id === "toolu_read");
    expect(outputIndex).toBe(items.indexOf(calls[0]!) + 1);
    expect(items[outputIndex]!.output).toBe("port = 8080");
  });

  it("drops Claude's signed thinking, which OpenAI cannot read", () => {
    expect(items.some((item) => item.type === "reasoning")).toBe(false);
    expect(bundle.report.dropped).toContainEqual(expect.objectContaining({ reason: "reasoning_not_portable" }));
  });

  it("keeps Codex's own reasoning and raw arguments when converting Codex to Codex", () => {
    const own = lines(engine.convert(codexShapedSession(), "codex", "fail")).map((record) => record.payload);
    expect(own.find((item) => item.type === "reasoning")).toMatchObject({ encrypted_content: "opaque-ciphertext" });
    expect(own.find((item) => item.call_id === "call_patch" && item.type === "function_call")?.arguments).toBe("*** Begin Patch\n*** End Patch");
    expect(own.find((item) => item.call_id === "call_lost" && item.type === "function_call_output")?.output).toMatch(/No result was recorded/u);
  });
});

describe("the Antigravity writer", () => {
  const bundle = engine.convert(codexShapedSession(), "antigravity-cli", "fail", undefined, { workspacePath: HERE });

  function read<T>(query: string): T {
    const directory = mkdtempSync(join(tmpdir(), "memoar-antigravity-test-"));
    const path = join(directory, "conversation.db");
    writeFileSync(path, bundle.files[0]!.bytes);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare(query).all() as T;
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("writes the conversation where agy --conversation looks for it", () => {
    expect(bundle.files.map((file) => file.path)).toEqual([`~/.gemini/antigravity-cli/conversations/${bundle.sessionId}.db`]);
    expect(read<{ user_version: number }[]>("PRAGMA user_version")).toEqual([{ user_version: 1 }]);
    expect(read<unknown[]>("SELECT cascade_id FROM trajectory_meta")).toEqual([{ cascade_id: bundle.sessionId }]);
  });

  it("alternates user input and planner response steps that carry the text", () => {
    const steps = read<{ step_type: number; step_payload: Uint8Array }[]>("SELECT step_type, step_payload FROM steps ORDER BY idx");
    expect(steps.map((step) => step.step_type)).toEqual([14, 15]);
    const user = Buffer.from(steps[0]!.step_payload).toString("utf8");
    const response = Buffer.from(steps[1]!.step_payload).toString("utf8");
    expect(user).toContain("List the fixtures and tell me which one is largest.");
    expect(user).not.toContain("AGENTS.md");
    expect(response).toContain("large.json is the largest fixture.");
    expect(response).toContain("[Memoar tool_call shell call_list]");
    expect(response).toContain("[Memoar tool_result call_list] large.json");
  });

  it("names the directory the conversation belongs to", () => {
    const blob = read<{ data: Uint8Array }[]>("SELECT data FROM trajectory_metadata_blob");
    expect(Buffer.from(blob[0]!.data).toString("utf8")).toContain(`file://${HERE}`);
  });
});

describe("the versions the writers claim", () => {
  it("are the ones the conversion matrix pins", () => {
    const pins = JSON.parse(readFileSync(resolve(process.cwd(), "../contracts/convert-matrix/versions.json"), "utf8")) as { targets: Record<string, string> };
    expect(pins.targets).toEqual(TARGET_VERSIONS);
  });
});
