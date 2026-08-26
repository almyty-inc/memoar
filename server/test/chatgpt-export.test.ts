import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";

const SEED: SessionSeed = {
  id: "0191cafe-0000-7000-8000-000000000140",
  source: { vendor: "openai", tool: "chatgpt-export", version: "2026-08", machineId: "0191cafe-0000-7000-8000-000000000001" },
  workspace: { path: "/workspace/example-1" },
  createdAt: "2026-08-03T09:00:00.000Z",
  updatedAt: "2026-08-03T09:00:00.000Z",
  title: "seeded",
  models: ["gpt-5"],
  tokenTotals: { input: 66, output: 87 },
  provenance: [{ kind: "import", capturedAt: "2026-08-03T09:00:00.000Z" }],
  visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-000000000002" },
};

function parse(raw: Uint8Array) {
  return new ParserRegistry().parse({ source: "chatgpt-export", version: "2026-08", raw, seed: SEED });
}

function node(id: string, parent: string | null, children: string[], role: string, part: string, extra: Record<string, unknown> = {}) {
  return { id, parent, children, message: { id, author: { role }, content: { content_type: "text", parts: [part] }, ...extra } };
}

function archive(conversations: unknown): Uint8Array {
  return zipSync({ "conversations.json": strToU8(JSON.stringify(conversations)) });
}

describe("chatgpt-export parser", () => {
  it("reads the ZIP a user actually downloads from ChatGPT", async () => {
    const raw = await readFile(resolve(process.cwd(), "../contracts/fixtures/chatgpt-export/2026-08/session-1/input/export.zip"));
    const result = parse(raw);
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;
    expect(session.title).toBe("Chatgpt Export fixture 1");
    expect(session.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    // The native parent id is the thing this format exists to preserve.
    expect(session.turns[1]!.parentId).toBe(session.turns[0]!.id);
    expect(session.turns[0]!.blocks[0]!.text).toContain("failing archive test");
  });

  it("orders a regenerated-answer tree depth-first so each branch stays contiguous", () => {
    // ChatGPT stores regenerations as sibling branches. Reading the mapping as
    // a flat object interleaves them, which reads as two conversations spliced
    // together rather than one thread with an alternative.
    const conversation = {
      id: "conv-1",
      title: "Branched",
      mapping: Object.fromEntries([
        node("root", null, ["q"], "system", ""),
        node("q", "root", ["a1", "a2"], "user", "question"),
        node("a1", "q", ["f1"], "assistant", "first answer"),
        node("f1", "a1", [], "user", "follow up on first"),
        node("a2", "q", [], "assistant", "regenerated answer"),
      ].map((entry) => [entry.id, entry])),
    };
    const result = parse(archive([conversation]));
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    const turns = result.sessions[0]!.turns;
    expect(turns.map((turn) => turn.blocks[0]?.text))
      .toEqual(["question", "first answer", "follow up on first", "regenerated answer"]);
    expect(turns.map((turn) => turn.ordinal)).toEqual([0, 1, 2, 3]);
    // These node ids are not UUIDs, so block ids come from the seed fallback.
    // They still have to be unique, or blocks collide on insert.
    const blockIds = turns.flatMap((turn) => turn.blocks.map((block) => block.id));
    expect(new Set(blockIds).size).toBe(blockIds.length);
  });

  it("reattaches turns across the dropped empty root instead of orphaning them", () => {
    // The synthetic root carries no content and is dropped. If parentId were
    // left pointing at it, the first real turn would reference a turn that is
    // not in the archive.
    const conversation = {
      id: "conv-2",
      mapping: Object.fromEntries([
        node("root", null, ["q"], "system", ""),
        node("q", "root", [], "user", "hello"),
      ].map((entry) => [entry.id, entry])),
    };
    const result = parse(archive([conversation]));
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    const turns = result.sessions[0]!.turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.parentId).toBeNull();
  });

  it("gathers one answer's reasoning and reply into a single assistant turn", () => {
    const conversation = {
      id: "conv-3",
      mapping: Object.fromEntries([
        node("q", null, ["t"], "user", "why?"),
        { id: "t", parent: "q", children: ["a"], message: { id: "t", author: { role: "assistant" }, content: { content_type: "thoughts", parts: ["weighing options"] } } },
        node("a", "t", [], "assistant", "because", { metadata: { model_slug: "gpt-5-thinking" } }),
      ].map((entry) => [entry.id, entry])),
    };
    const result = parse(archive([conversation]));
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    const turns = result.sessions[0]!.turns;
    // ChatGPT writes reasoning and reply as separate nodes. Kept apart they
    // become two assistant turns, which reads nothing like the same exchange
    // captured from any other agent.
    expect(turns).toHaveLength(2);
    expect(turns[1]!.role).toBe("assistant");
    expect(turns[1]!.blocks.map((block) => block.kind)).toEqual(["thinking", "text"]);
    expect(turns[1]!.blocks[1]!.text).toBe("because");
    // The export states the model per message; the seed is only a fallback.
    expect(turns[1]!.model).toBe("gpt-5-thinking");
  });

  it("splits a multi-conversation account export into distinct sessions", () => {
    const result = parse(archive([
      { id: "conv-a", title: "First", mapping: Object.fromEntries([node("a", null, [], "user", "one")].map((e) => [e.id, e])) },
      { id: "conv-b", title: "Second", mapping: Object.fromEntries([node("b", null, [], "user", "two")].map((e) => [e.id, e])) },
    ]));
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((session) => session.source.nativeSessionId)).toEqual(["conv-a", "conv-b"]);
    // Distinct archive ids, or the second import would overwrite the first.
    expect(result.sessions[0]!.id).not.toBe(result.sessions[1]!.id);
  });

  it("reports a diagnostic and preserves bytes for an archive with no conversations file", () => {
    const raw = zipSync({ "readme.txt": strToU8("not an export") });
    const result = parse(raw);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("conversations.json");
    expect(Buffer.from(result.raw)).toEqual(Buffer.from(raw));
  });

  it("accepts a bare conversations.json, since people upload the file itself", () => {
    const result = parse(strToU8(JSON.stringify([
      { id: "conv-bare", title: "Bare", mapping: Object.fromEntries([node("x", null, [], "user", "hi")].map((e) => [e.id, e])) },
    ])));
    expect(result.kind).toBe("parsed");
  });
});
