import { describe, expect, it } from "vitest";
import { ingest, jsonLines } from "./helpers/native-store.js";

/**
 * Line-oriented stores whose layout moved. Synthetic content throughout, in
 * the record shapes each tool's own source defines.
 */

describe("codex", () => {
  it("records the model of each turn from the turn_context before it", () => {
    const message = (role: string, text: string) => ({
      type: "response_item",
      timestamp: "2026-11-01T00:00:00.000Z",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    });
    const raw = jsonLines([
      { type: "session_meta", payload: { id: "rollout-1", cwd: "/w" } },
      { type: "turn_context", payload: { model: "model-one", cwd: "/w" } },
      message("user", "first"),
      message("assistant", "reply one"),
      { type: "turn_context", payload: { model: "model-two", cwd: "/w" } },
      message("user", "second"),
      message("assistant", "reply two"),
    ]);
    const { result } = ingest("codex", raw);
    if (result.kind !== "parsed") throw new Error(result.kind === "unknown" ? result.diagnostic : result.kind);
    const [session] = result.sessions;
    expect(session!.turns.filter((turn) => turn.role === "assistant").map((turn) => turn.model)).toEqual(["model-one", "model-two"]);
    expect(session!.models).toEqual(["model-one", "model-two"]);
  });
});

describe("copilot cli events.jsonl", () => {
  const event = (type: string, data: Record<string, unknown>, at = "2026-11-01T00:00:00.000Z") =>
    ({ id: `${type}-${Math.random()}`, parentId: null, timestamp: at, type, data });

  it("reads a session from the SDK's event schema", () => {
    const raw = jsonLines([
      event("session.start", { sessionId: "s-1", copilotVersion: "1.0.0", producer: "cli", startTime: "2026-11-01T00:00:00.000Z", version: 1, selectedModel: "model-c", context: { cwd: "/work/c" } }),
      event("user.message", { content: "list files" }),
      event("assistant.message_delta", { deltaContent: "par" }),
      event("assistant.message", { messageId: "m1", content: "I will list them.", reasoningText: "need ls", toolRequests: [{ toolCallId: "t1", name: "bash", arguments: { command: "ls" } }] }),
      event("tool.execution_start", { toolCallId: "t1", toolName: "bash", arguments: { command: "ls" } }),
      event("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: "a.txt" } }),
      event("tool.execution_complete", { toolCallId: "t2", success: false, error: { message: "denied" } }),
      event("session.title_changed", { title: "Listing files" }),
    ]);
    const { format, result } = ingest("copilot", raw);
    expect(format.version).toBe("v1");
    if (result.kind !== "parsed") throw new Error(result.kind === "unknown" ? result.diagnostic : result.kind);
    const [session] = result.sessions;
    expect(session!.source.nativeSessionId).toBe("s-1");
    expect(session!.title).toBe("Listing files");
    expect(session!.workspace.path).toBe("/work/c");
    expect(session!.models).toEqual(["model-c"]);
    expect(session!.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    const kinds = session!.turns[1]!.blocks.map((block) => block.kind);
    expect(kinds).toEqual(["thinking", "text", "tool_call", "tool_result", "tool_result"]);
    expect(session!.turns[1]!.blocks.filter((block) => block.kind === "tool_call")).toHaveLength(1);
    expect(session!.turns[1]!.blocks[4]!.data).toEqual({ isError: true });
    expect(session!.turns[1]!.model).toBe("model-c");
  });

  it("calls a session that was opened and never used empty", () => {
    const raw = jsonLines([event("session.start", { sessionId: "s-2", copilotVersion: "1", producer: "cli", startTime: "x", version: 1 })]);
    expect(ingest("copilot", raw).result.kind).toBe("empty");
  });
});

describe("vs code chat session log", () => {
  const envelope = { version: 3, sessionId: "panel-1", creationDate: 1767225600000, requests: [] as unknown[] };
  const request = (text: string, reply: string) => ({
    requestId: `r-${text}`,
    message: { text },
    response: [{ value: reply }],
    timestamp: 1767225601000,
  });

  it("replays kind 2 appends and kind 3 deletes after the snapshot", () => {
    const raw = jsonLines([
      { kind: 0, v: envelope },
      { kind: 2, k: ["requests"], v: [request("one", "answer one")] },
      { kind: 2, k: ["requests"], v: [request("two", "answer two")] },
      { kind: 1, k: ["customTitle"], v: "Renamed" },
      { kind: 2, k: ["requests"], i: 1, v: [request("three", "answer three")] },
      { kind: 3, k: ["customTitle"] },
    ]);
    const { result } = ingest("copilot", raw);
    if (result.kind !== "parsed") throw new Error(result.kind === "unknown" ? result.diagnostic : result.kind);
    const texts = result.sessions[0]!.turns.map((turn) => turn.blocks.map((block) => block.text).join(""));
    expect(texts).toEqual(["one", "answer one", "three", "answer three"]);
    expect(result.sessions[0]!.title).not.toBe("Renamed");
  });

  it("detects a compacted log whose snapshot line is past the sniff window", () => {
    const big = { ...envelope, requests: Array.from({ length: 200 }, (_, index) => request(`q${index} ${"x".repeat(600)}`, "a")) };
    const raw = jsonLines([{ kind: 0, v: big }]);
    expect(raw.byteLength).toBeGreaterThan(64 * 1024);
    const { format, result } = ingest("copilot", raw);
    expect(format.version).toBe("v1");
    expect(result.kind).toBe("parsed");
  });
});
