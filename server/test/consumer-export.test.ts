import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";

const SEED: SessionSeed = {
  id: "0191cafe-0000-7000-8000-00000000014a",
  source: { vendor: "anthropic", tool: "claude-ai-export", version: "2026-08", machineId: "0191cafe-0000-7000-8000-000000000001" },
  workspace: { path: "/workspace/example-1" },
  createdAt: "2026-08-04T09:00:00.000Z",
  updatedAt: "2026-08-04T09:00:00.000Z",
  title: "seeded",
  models: ["claude-sonnet"],
  tokenTotals: { input: 67, output: 88 },
  provenance: [{ kind: "import", capturedAt: "2026-08-04T09:00:00.000Z" }],
  visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-000000000002" },
};

const SOURCES = ["claude-ai-export", "gemini-export", "mistral-export", "perplexity-export"] as const;

function parse(raw: Uint8Array, source: string = "claude-ai-export") {
  return new ParserRegistry().parse({ source, version: "2026-08", raw, seed: SEED });
}

function message(id: string, parentId: string | null, role: string, text: string) {
  return { id, parentId, role, createdAt: "2026-08-04T09:00:00.000Z", blocks: [{ id: `${id}-b`, kind: "text", text }] };
}

function archive(conversations: unknown, entry = "conversations.json"): Uint8Array {
  return zipSync({ [entry]: strToU8(JSON.stringify(conversations)) });
}

describe("consumer export parsers", () => {
  it.each(SOURCES)("registers %s so an upload is not stored as an unknown format", (source) => {
    const raw = archive([{ uuid: "conv-1", name: "Titled", messages: [message("m1", null, "user", "hello")] }]);
    const result = parse(raw, source);
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.parser).toContain(source);
  });

  it("reads the payload however deeply the vendor nests it", async () => {
    // Gemini's archive puts conversations.json under a Gemini/ directory; the
    // others put it at the root. Matching by suffix covers both without a
    // per-vendor path table that would drift.
    const raw = await readFile(resolve(process.cwd(), "../contracts/fixtures/gemini-export/2026-08/session-1/input/export.zip"));
    expect(parse(raw, "gemini-export").kind).toBe("parsed");
  });

  it("prefers the shallowest payload when an archive holds more than one", () => {
    const raw = zipSync({
      "conversations.json": strToU8(JSON.stringify([{ uuid: "real", name: "Real", messages: [message("m1", null, "user", "real")] }])),
      "backup/old/conversations.json": strToU8(JSON.stringify([{ uuid: "old", name: "Old", messages: [message("m2", null, "user", "old")] }])),
    });
    const result = parse(raw);
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions[0]!.title).toBe("Real");
  });

  it("preserves the parent link that makes a thread a thread", () => {
    const raw = archive([{
      uuid: "conv-1",
      name: "Threaded",
      messages: [message("m1", null, "user", "question"), message("m2", "m1", "assistant", "answer")],
    }]);
    const result = parse(raw);
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    const turns = result.sessions[0]!.turns;
    expect(turns.map((turn) => turn.ordinal)).toEqual([0, 1]);
    expect(turns[1]!.parentId).toBe("m1");
    expect(turns[1]!.role).toBe("assistant");
  });

  it("splits a multi-conversation archive into sessions with distinct ids", () => {
    const raw = archive([
      { uuid: "a", name: "First", messages: [message("m1", null, "user", "one")] },
      { uuid: "b", name: "Second", messages: [message("m2", null, "user", "two")] },
    ]);
    const result = parse(raw);
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions.map((session) => session.title)).toEqual(["First", "Second"]);
    // Colliding ids would make the second import overwrite the first.
    expect(result.sessions[0]!.id).not.toBe(result.sessions[1]!.id);
  });

  it("accepts a bare conversations.json, since people upload the file itself", () => {
    const raw = strToU8(JSON.stringify([{ uuid: "conv-1", name: "Bare", messages: [message("m1", null, "user", "hi")] }]));
    expect(parse(raw).kind).toBe("parsed");
  });

  it("reports a diagnostic and preserves the bytes when the payload is absent", () => {
    const raw = zipSync({ "readme.txt": strToU8("not an export") });
    const result = parse(raw);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("conversations.json");
    expect(Buffer.from(result.raw)).toEqual(Buffer.from(raw));
  });

  it("reports a diagnostic for a conversation that carries no messages", () => {
    const result = parse(archive([{ uuid: "conv-1", name: "Empty", messages: [] }]));
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("no conversations with messages");
  });
});
