import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session } from "../libs/canonical/src/generated.js";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";

const cases = [
  ["claude-code", "v1", "session.jsonl"],
  ["codex", "rollout-v1", "session.jsonl"],
  ["antigravity-cli", "v1", "native.sqlite3"],
  ["cursor", "v3", "native.sqlite3"],
  ["goose", "v1", "native.sqlite3"],
  ["crush", "v1", "native.sqlite3"],
  ["zed", "v1", "native.sqlite3"],
  ["canonical-bundle", "v1", "bundle.json"],
  ["cass-export", "2026-08", "cass.json"],
] as const;

describe("Tier-1 parsers", () => {
  for (const [source, version, filename] of cases) {
    it(`normalizes ${source}@${version} fixture shape byte-exact`, async () => {
      const fixture = resolve(process.cwd(), "../contracts/fixtures", source, version, "session-1");
      const [raw, expectedBytes] = await Promise.all([
        readFile(resolve(fixture, "input", filename)),
        readFile(resolve(fixture, "expected.canonical.json")),
      ]);
      const expected = JSON.parse(expectedBytes.toString("utf8")) as Session;
      const seed = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "turns")) as SessionSeed;
      const result = new ParserRegistry().parse({ source, version, raw, seed });
      expect(result.kind).toBe("parsed");
      if (result.kind === "parsed") {
        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).toEqual(expected);
      }
    });
  }

  it("converts parser crashes into unknown results that preserve the bytes", () => {
    const raw = Buffer.from(`${JSON.stringify({
      uuid: "0191cafe-0000-7000-8000-0000000take0b",
      parentUuid: null,
      type: "user",
      message: { role: "user", content: "corrupted identifiers" },
    })}\n`);
    const seed = {
      id: "0191cafe-0000-7000-8000-00000000f011",
      source: { vendor: "anthropic", tool: "claude-code", version: "v1", machineId: "0191cafe-0000-7000-8000-00000000f012" },
      workspace: { path: "/workspace/broken" },
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      title: "Broken identifiers",
      models: [],
      tokenTotals: { input: 0, output: 0 },
      provenance: [{ kind: "native" as const, capturedAt: "2026-08-20T00:00:00.000Z" }],
      visibility: { scope: "private" as const, ownerId: "0191cafe-0000-7000-8000-00000000f013" },
    };
    const result = new ParserRegistry().parse({ source: "claude-code", version: "v1", raw, seed });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.diagnostic).toContain("threw");
      expect(Buffer.from(result.raw)).toEqual(raw);
    }
  });

  it("preserves unknown-format bytes and returns a diagnostic", () => {
    const raw = Buffer.from("future-vendor-format\u0000opaque");
    const seed = {
      id: "0191cafe-0000-7000-8000-00000000f001",
      source: { vendor: "future", tool: "future", version: "v99", machineId: "0191cafe-0000-7000-8000-00000000f002" },
      workspace: { path: "/workspace/future" },
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      title: "Future format",
      models: [],
      tokenTotals: { input: 0, output: 0 },
      provenance: [{ kind: "native" as const, capturedAt: "2026-08-17T00:00:00.000Z" }],
      visibility: { scope: "private" as const, ownerId: "0191cafe-0000-7000-8000-00000000f003" },
    };
    const result = new ParserRegistry().parse({ source: "future", version: "v99", raw, seed });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.diagnostic).toContain("Raw bytes were preserved");
      expect(Buffer.from(result.raw)).toEqual(raw);
    }
  });

  it("rejects a corrupted SQLite artifact with an integrity diagnostic and preserves the bytes", async () => {
    const fixture = resolve(process.cwd(), "../contracts/fixtures", "cursor", "v3", "session-1");
    const [valid, expectedBytes] = await Promise.all([
      readFile(resolve(fixture, "input", "native.sqlite3")),
      readFile(resolve(fixture, "expected.canonical.json")),
    ]);
    const expected = JSON.parse(expectedBytes.toString("utf8")) as Session;
    const seed = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "turns")) as SessionSeed;
    const corrupted = Buffer.from(valid);
    corrupted.fill(0xff, corrupted.length - 1200, corrupted.length - 16);
    const result = new ParserRegistry().parse({ source: "cursor", version: "v3", raw: corrupted, seed });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.diagnostic).toContain("cursor v3 sqlite decode failed");
      expect(Buffer.from(result.raw)).toEqual(corrupted);
    }
  });
});