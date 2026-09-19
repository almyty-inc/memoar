import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMemoryBundle } from "../src/convert/memory-conversion.js";
import {
  MEMORY_DIALECTS,
  MEMORY_DIALECT_PATHS,
  MEMORY_SOURCE_TOOLS,
  type MemoryDestination,
} from "../src/convert/memory-dialects.js";

/**
 * One dialect table, in three places.
 *
 * The connector table in `memoar-connectors` says which file each tool reads —
 * that is the ground truth, and it is the thing that grows whenever a tool
 * ships. The server decides where a conversion writes. The materializer decides
 * where it will let a conversion write. Three lists in two languages with
 * nothing comparing them is exactly the shape that broke `memoar login` in CI
 * and made a batch of browser-minted API keys inert, both in one day.
 *
 * Here the cost of a disagreement is quieter and worse: the server writes
 * `~/.codex/AGENT.md`, the materializer refuses it as an unsafe path, and the
 * conversion fails on the user's machine and nowhere else. Or the two agree
 * with each other and disagree with the connector table, and the file lands
 * somewhere the tool never reads and memoar never captures again.
 */
async function read(relativePath: string): Promise<string> {
  return readFile(resolve(process.cwd(), relativePath), "utf8");
}

const CONNECTORS = "../agent/crates/memoar-connectors/src/memory_files.rs";
const DIALECTS = "../agent/crates/memoar-materializer/src/memory_dialects.rs";

interface CapturePattern {
  pattern: string;
  scope: "global" | "project";
  readers: string[];
}

/** The `MEMORY_FILES` table, which is read-only ground truth to this side. */
function captureTable(source: string): CapturePattern[] {
  const entries = [...source.matchAll(
    /MemorySpec\s*\{\s*pattern:\s*"([^"]+)",\s*scope:\s*MemoryScope::(\w+),\s*readers:\s*&\[([^\]]*)\],\s*\}/gu,
  )];
  return entries.map((entry) => ({
    pattern: entry[1]!,
    scope: entry[2]!.toLowerCase() as "global" | "project",
    readers: [...entry[3]!.matchAll(/"([^"]+)"/gu)].map((reader) => reader[1]!),
  }));
}

/** The materializer's copy of the destinations, parsed out of its match arms. */
function rustDestinations(source: string): Record<string, Partial<Record<string, MemoryDestination>>> {
  const names = new Map([...source.matchAll(/Self::(\w+) => "([a-z-]+)",/gu)].map((m) => [m[1]!, m[2]!]));
  expect(names.size, "no dialect names were parsed; has as_str changed shape?").toBeGreaterThan(5);
  const table: Record<string, Partial<Record<string, MemoryDestination>>> = {};
  for (const variant of names.values()) table[variant] = {};
  const arms = [...source.matchAll(
    /\(MemoryDialect::(\w+),\s*(true|false|_)\)\s*=>\s*(?:None|Some\((File|Directory)\("([^"]+)"\)\))/gu,
  )];
  expect(arms.length, "no destination arms were parsed; has the match changed shape?").toBeGreaterThan(10);
  for (const arm of arms) {
    const dialect = names.get(arm[1]!);
    if (!dialect) throw new Error(`no wire name for MemoryDialect::${arm[1]}`);
    if (!arm[3]) continue;
    const destination: MemoryDestination = { kind: arm[3] === "File" ? "file" : "directory", path: arm[4]! };
    const scopes = arm[2] === "_" ? ["global", "project"] : [arm[2] === "true" ? "global" : "project"];
    for (const scope of scopes) table[dialect]![scope] = destination;
  }
  return table;
}

describe("the dialects the server converts into", () => {
  it("are tools the connector table actually captures for", async () => {
    const readers = new Set(captureTable(await read(CONNECTORS)).flatMap((entry) => entry.readers));
    expect(readers.size, "no readers were parsed; has MEMORY_FILES changed shape?").toBeGreaterThan(5);
    expect([...MEMORY_SOURCE_TOOLS].sort(), "a source memoar never captures for can never be converted from")
      .toEqual([...readers].sort());
    // Cursor is a source and never a target: it reads nothing from a `.mdc`
    // with no frontmatter, and inventing frontmatter is not a port.
    expect(MEMORY_SOURCE_TOOLS).toContain("cursor");
    expect(MEMORY_DIALECTS).not.toContain("cursor");
    expect([...MEMORY_DIALECTS].sort())
      .toEqual([...MEMORY_SOURCE_TOOLS].filter((tool) => tool !== "cursor").sort());
  });

  it("write only where the connector table already looks", async () => {
    const capture = captureTable(await read(CONNECTORS));
    for (const dialect of MEMORY_DIALECTS) {
      for (const [scope, destination] of Object.entries(MEMORY_DIALECT_PATHS[dialect])) {
        // A rules directory is captured as a recursive glob over that directory.
        const wanted = destination.kind === "file" ? destination.path : `${destination.path}/**/*.md`;
        const match = capture.find((entry) =>
          entry.pattern === wanted && entry.scope === scope && entry.readers.includes(dialect));
        expect(match, `nothing captures ${wanted} for ${dialect} (${scope}); a port there is a file memoar loses sight of`)
          .toBeDefined();
      }
    }
  });

  it("land where the materializer is willing to write them", async () => {
    const rust = rustDestinations(await read(DIALECTS));
    const mine = Object.fromEntries(MEMORY_DIALECTS.map((dialect) => [dialect, MEMORY_DIALECT_PATHS[dialect]]));
    expect(rust, "the archive would write a path the machine refuses as unsafe").toEqual(mine);
  });

  it("are the ones the web app offers", async () => {
    // A target the page offers and the archive refuses is a control that does
    // nothing; one the archive supports and the page omits is a feature nobody
    // can reach. Neither shows up in either side's own tests.
    const types = await read("../web/src/lib/types.ts");
    const block = /export const MEMORY_DIALECTS = \[([^\]]*)\] as const;/u.exec(types);
    expect(block, "web/src/lib/types.ts should declare MEMORY_DIALECTS").not.toBeNull();
    const offered = [...block![1]!.matchAll(/'([a-z-]+)'/gu)].map((match) => match[1]!);
    expect(offered).toEqual([...MEMORY_DIALECTS]);
  });
});

/**
 * The digest, which is the other thing two languages have to agree about.
 *
 * The materializer recomputes `bundleSha256` over the manifest before it writes
 * anything, and refuses the bundle if its own answer differs. Field order,
 * whether an absent workspace is `null` or missing, how a number is rendered —
 * any of it disagreeing means every conversion fails on the machine and none of
 * them fails in CI.
 *
 * So one bundle is committed, both sides are held to it, and neither can move
 * alone: this test fails if the server's bytes change, and
 * `tests::memory::materializes_the_committed_server_bundle` fails if the
 * materializer's digest does.
 */
describe("the bundle the server writes", () => {
  it("is byte for byte the one the materializer is tested against", async () => {
    const fixture = await read("../contracts/fixtures/memory-conversion-bundle.json");
    const built = buildMemoryBundle({
      source: "claude-code",
      target: "codex",
      scope: "global",
      sources: [
        { path: "/Users/x/.claude/CLAUDE.md", text: "Small files. Real coverage.\n" },
        { path: "/Users/x/.claude/projects/p/memory/note.md", text: "Frane prefers domain modules.\n" },
      ],
    });
    expect(`${JSON.stringify(built, null, 2)}\n`).toBe(fixture);
  });
});
