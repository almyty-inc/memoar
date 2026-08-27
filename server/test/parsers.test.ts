import { readdir, readFile } from "node:fs/promises";
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
  // These four carry an identical envelope and are genuine conformance pairs:
  // every id, block and title in the expected output derives from the input.
  ["claude-ai-export", "2026-08", "export.zip"],
  ["gemini-export", "2026-08", "export.zip"],
  ["mistral-export", "2026-08", "export.zip"],
  ["perplexity-export", "2026-08", "export.zip"],
  // These six store the same message shape in six different places: a SQLite
  // column, an editor's key/value store, a threads array, a task history, and
  // an append-only event log.
  ["warp", "v1", "native.sqlite3"],
  ["windsurf", "v1", "native.sqlite3"],
  ["amp", "v1", "thread.json"],
  ["kilo", "v1", "task.json"],
  ["roo", "v1", "task.json"],
  ["pi-agent", "v1", "session.jsonl"],
  ["antigravity-ide", "v1", "native.sqlite3"],
  ["chatgpt-export", "2026-08", "export.zip"],
  // Written against the real schema, read off an opencode install on this
  // machine, and verified against that database before the fixture was built.
  ["opencode", "v1", "native.sqlite3"],
  // Real schema, read off an installed Copilot CLI; that install had no
  // recorded exchanges, so this is verified against the schema, not a
  // transcript.
  ["copilot", "v1", "native.sqlite3"],
] as const;

const FIXTURE_IS_SCAFFOLDING = new Set([
  "aider", "cline", "continue", "droid", "kimi", "openhands", "qwen",
]);

/** Every fixture format now has a parser, scaffolding aside. */
const UNIMPLEMENTED = new Set<string>([]);

describe("fixture corpus coverage", () => {
  it("accounts for every fixture format as either covered or explicitly unimplemented", async () => {
    const root = resolve(process.cwd(), "../contracts/fixtures");
    const formats = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const covered = new Set<string>(cases.map(([source]) => source));
    const accounted = (format: string) =>
      covered.has(format) || UNIMPLEMENTED.has(format)
      || FIXTURE_IS_SCAFFOLDING.has(format);
    const unaccounted = formats.filter((format) => !accounted(format));
    expect(unaccounted, "new fixture formats must be given a parser case or listed as unimplemented").toEqual([]);
    // Keeps the list honest in the other direction: once a parser lands, its
    // entry has to be removed here rather than lingering as a false gap.
    const stale = [...UNIMPLEMENTED, ...FIXTURE_IS_SCAFFOLDING]
      .filter((format) => covered.has(format) || !formats.includes(format));
    expect(stale, "these are covered or gone; drop them from the exception lists").toEqual([]);
  });
});

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