import type { ContentBlock, Session, Turn } from "../../libs/canonical/src/generated.js";

/**
 * Synthetic sessions in the shapes the parsers produce for each source, for
 * the native writer tests. Nothing here was copied from a real session.
 */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let counter = 0;
function id(): string {
  counter += 1;
  return `0191cafe-0000-7000-8000-${counter.toString(16).padStart(12, "0")}`;
}

function block(kind: ContentBlock["kind"], fields: Partial<ContentBlock> = {}): ContentBlock {
  return { id: id(), kind, ...fields };
}

function turns(rows: [Turn["role"], ContentBlock[], string?][]): Turn[] {
  let parentId: string | null = null;
  return rows.map(([role, blocks, model], ordinal) => {
    const turn: Turn = {
      id: id(), ordinal, parentId, role, createdAt: `2026-09-01T10:00:${String(ordinal).padStart(2, "0")}.000Z`,
      ...(model ? { model } : {}), blocks,
    };
    parentId = turn.id;
    return turn;
  });
}

function session(tool: string, vendor: string, rows: [Turn["role"], ContentBlock[], string?][]): Session {
  return {
    id: id(),
    source: { vendor, tool, version: "test", machineId: "0191cafe-0000-7000-8000-0000000000aa" },
    workspace: { path: "/workspace/source-project", branch: "main" },
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:05:00.000Z",
    title: "Synthetic conversion session",
    models: [vendor === "openai" ? "gpt-test" : "claude-test"],
    tokenTotals: { input: 1, output: 1 },
    provenance: [],
    visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-0000000000bb" },
    turns: turns(rows),
  };
}

/** A Codex rollout as parsed: harness text, encrypted reasoning, calls and results in one turn. */
export function codexShapedSession(): Session {
  return session("codex", "openai", [
    ["system", [block("text", { text: "Developer instructions for the test harness." })]],
    ["user", [block("text", { text: "# AGENTS.md instructions for /workspace/source-project\n\n<INSTRUCTIONS>\nUse tabs.\n</INSTRUCTIONS>" })]],
    ["user", [
      block("text", { text: "<environment_context>\n  <cwd>/workspace/source-project</cwd>\n</environment_context>" }),
      block("text", { text: "List the fixtures and tell me which one is largest." }),
      block("attachment", { mimeType: "image/png", data: { imageUrl: `data:image/png;base64,${PNG}` } }),
    ]],
    ["assistant", [
      block("thinking", { text: "Listing first.", data: { encrypted: "opaque-ciphertext" } }),
      block("tool_call", { name: "shell", callId: "call_list", data: { command: ["ls", "-S"] } }),
      block("tool_result", { callId: "call_list", text: "large.json\nsmall.json" }),
      block("tool_call", { name: "apply_patch", callId: "call_patch", data: { arguments: "*** Begin Patch\n*** End Patch" } }),
      block("tool_result", { callId: "call_patch", text: "Done" }),
      block("tool_call", { name: "shell", callId: "call_lost", data: { command: ["true"] } }),
      block("text", { text: "large.json is the largest fixture." }),
    ], "gpt-test"],
    ["system", [block("system", { name: "compaction", text: "Compaction summary of the turns above." })]],
  ]);
}

/** A Claude Code transcript as parsed: signed thinking, a call answered in the next user turn. */
export function claudeShapedSession(): Session {
  return session("claude-code", "anthropic", [
    ["user", [block("text", { text: "Read the config and say which port it uses." })]],
    ["assistant", [
      block("thinking", { text: "I should read the file.", data: { signature: "sig-test" } }),
      block("text", { text: "Reading it now." }),
      block("tool_call", { name: "Read", callId: "toolu_read", data: { file_path: "/workspace/source-project/config.toml" } }),
    ], "claude-test"],
    ["user", [block("tool_result", { callId: "toolu_read", text: "port = 8080", data: { isError: false } })]],
    ["user", [
      block("text", { text: "Here is a screenshot." }),
      block("attachment", { mimeType: "image/png", data: { source: { type: "base64", media_type: "image/png", data: PNG } } }),
    ]],
    ["assistant", [block("text", { text: "The config uses port 8080." })], "claude-test"],
  ]);
}
