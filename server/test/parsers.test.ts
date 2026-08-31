import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session } from "../libs/canonical/src/generated.js";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";

const cases = [
  ["claude-code", "v1", "session.jsonl"],
  ["codex", "rollout-v1", "session.jsonl"],
  ["antigravity-cli", "v1", "transcript.jsonl"],
  ["cursor", "v3", "native.sqlite3"],
  ["goose", "v1", "native.sqlite3"],
  ["crush", "v1", "native.sqlite3"],
  ["zed", "v1", "native.sqlite3"],
  ["canonical-bundle", "v1", "bundle.json"],
  ["cass-export", "2026-08", "cass.json"],
  // These four carry an identical envelope and are genuine conformance pairs:
  // every id, block and title in the expected output derives from the input.
  // These six store the same message shape in six different places: a SQLite
  // column, an editor's key/value store, a threads array, a task history, and
  // an append-only event log.
  ["kilo", "v1", "task.json"],
  ["roo", "v1", "task.json"],
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

/**
 * Formats whose shape was confirmed against the tool itself — a real file from
 * an install, the project's own schema, or a reference implementation — rather
 * than against a fixture someone wrote to match the parser.
 *
 * This distinction is the point. Every parser here once passed its fixture
 * while being unable to read a single real file, because fixture and parser
 * were written from the same guess and agreed with each other. A fixture only
 * tests something when it comes from a source the parser did not.
 */
const VERIFIED_AGAINST_THE_TOOL: Readonly<Record<string, string>> = {
  "claude-code": "parsed a real 4,369-turn session from this machine",
  codex: "parsed a real rollout from this machine",
  zed: "parsed a real threads.db from this machine",
  "antigravity-cli": "parsed a real transcript log from this machine",
  opencode: "parsed a real 47-turn session from this machine",
  copilot: "schema read from an installed Copilot CLI; that install had no recorded turns",
  goose: "schema from block/goose session_manager.rs",
  crush: "schema from charmbracelet/crush initial migration",
  cursor: "two-table layout from the community reference implementations",
  kilo: "api_conversation_history.json shape from RooCodeInc/Roo-Code",
  roo: "api_conversation_history.json shape from RooCodeInc/Roo-Code",
  "canonical-bundle": "memoar's own export format",
  "cass-export": "memoar's own import format",
  "chatgpt-export": "mapping tree and content_type confirmed against an open-source export parser",
};

/**
 * Parsers that exist and pass a fixture, but whose shape has never been checked
 * against the tool. Treat every one as probably wrong: of the nine formats that
 * have been checked, eight were.
 *
 * warp and windsurf are closed source and not installed here. amp keeps threads
 * on Sourcegraph's servers rather than on disk, so there may be no local
 * artifact to import at all. The four consumer exports read the shape the
 * contract fixture describes, which is not what those vendors download —
 * they stay out of the Import UI for that reason.
 */
/**
 * Nothing. A format whose shape cannot be checked against the tool is not
 * supported: its parser and fixture are removed rather than kept passing.
 * warp and windsurf are closed source and were not installable here, amp keeps
 * its threads on Sourcegraph's servers rather than on disk, and the consumer
 * exports read a shape the vendors do not write.
 */
const UNCONFIRMED_SHAPE = new Set<string>([]);

describe("fixture corpus coverage", () => {
  it("says of every parser whether its shape was ever checked against the tool", () => {
    // A parser is either confirmed against something the author did not write,
    // or it is listed as unconfirmed. Silence is what let eight parsers ship
    // unable to read their own tool's output.
    const covered = cases.map(([source]) => source);
    const unaccounted = covered.filter((source) =>
      VERIFIED_AGAINST_THE_TOOL[source] === undefined && !UNCONFIRMED_SHAPE.has(source));
    expect(unaccounted, "state whether these were checked against the tool").toEqual([]);

    const contradictory = [...UNCONFIRMED_SHAPE].filter((source) => VERIFIED_AGAINST_THE_TOOL[source] !== undefined);
    expect(contradictory, "these cannot be both confirmed and unconfirmed").toEqual([]);
  });


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

  it.each(cases)("gives %s@%s distinct ids for every turn and block", async (source, version, filename) => {
    // Block ids used to be derived from the turn id, and native stores allocate
    // message ids sequentially, so a block id landed on the next turn's id.
    // Duplicates here would collide on insert and silently lose content.
    const fixture = resolve(process.cwd(), "../contracts/fixtures", source, version, "session-1");
    const [raw, expectedBytes] = await Promise.all([
      readFile(resolve(fixture, "input", filename)),
      readFile(resolve(fixture, "expected.canonical.json")),
    ]);
    const expected = JSON.parse(expectedBytes.toString("utf8")) as Session;
    const seed = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "turns")) as SessionSeed;
    const result = new ParserRegistry().parse({ source, version, raw, seed });
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    for (const session of result.sessions) {
      const ids = session.turns.flatMap((turn) => [turn.id, ...turn.blocks.map((block) => block.id)]);
      expect(new Set(ids).size, `${source} minted a duplicate id`).toBe(ids.length);
    }
  });

  it.each(cases)("gives %s@%s canonical uuids for every generated id", async (source, version, filename) => {
    // A tool call names itself with an id that is the id of the *call*
    // — "toolu_01…" from Anthropic — and taking it as the block's own id put a
    // non-uuid where the contract requires one. Only the contract check caught
    // it, and only for one fixture.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const fixture = resolve(process.cwd(), "../contracts/fixtures", source, version, "session-1");
    const [raw, expectedBytes] = await Promise.all([
      readFile(resolve(fixture, "input", filename)),
      readFile(resolve(fixture, "expected.canonical.json")),
    ]);
    const expected = JSON.parse(expectedBytes.toString("utf8")) as Session;
    const seed = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "turns")) as SessionSeed;
    const result = new ParserRegistry().parse({ source, version, raw, seed });
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    for (const session of result.sessions) {
      for (const turn of session.turns) {
        for (const block of turn.blocks) {
          expect(uuid.test(block.id), `${source} block id is not a uuid: ${block.id}`).toBe(true);
        }
      }
    }
  });

  it("converts parser crashes into unknown results that preserve the bytes", () => {
    // A record whose uuid is not hexadecimal used to crash claude-code, because
    // block ids were derived by doing arithmetic on it. Block ids now come from
    // the seed, so that input parses; a genuine crash needs something the
    // parser cannot survive at all, which is what the seed below provides.
    const raw = Buffer.from(`${JSON.stringify({
      uuid: "0191cafe-0000-7000-8000-00000000000b",
      parentUuid: null,
      type: "user",
      message: { role: "user", content: "corrupted identifiers" },
    })}\n`);
    const seed = {
      // Not a UUID, so deriving any id from it throws inside the parser.
      id: "not-a-uuid-at-all",
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