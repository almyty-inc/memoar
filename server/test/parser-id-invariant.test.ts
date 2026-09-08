import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isUuid } from "../libs/parsers/src/common.js";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import type { SessionSeed } from "../libs/parsers/src/types.js";

/**
 * Every id a parser emits has to be storable.
 *
 * Turn ids, block ids and parent links are uuid columns. Parsers used to hand
 * the source's own id straight to them, which works only for as long as every
 * tool numbers its messages with uuids — and when one does not, the database
 * refuses the whole session after it parsed perfectly. That is not a crash: it
 * is a transcript that was captured, accepted, and quietly never archived.
 *
 * Every fixture in this repository uses uuids, so no fixture test could catch
 * it; the fixtures were written by whoever wrote the parsers. This runs each
 * parser over its own fixture with the ids rewritten to shapes real tools
 * actually use — `msg_01H…`, `ses_abc`, plain integers — and checks that what
 * comes out is storable anyway.
 */

const FIXTURES = resolve(process.cwd(), "../contracts/fixtures");
const SEED_ID = "0191cafe-0000-7000-8000-0000000000e0";

function seed(): SessionSeed {
  return {
    id: SEED_ID,
    source: { vendor: "test", tool: "test", version: "v1", machineId: "0191cafe-0000-7000-8000-0000000000e1", nativeSessionId: "native" },
    workspace: { path: "/workspace" },
    createdAt: "2026-09-08T10:00:00.000Z",
    updatedAt: "2026-09-08T10:00:00.000Z",
    title: "fixture",
    models: ["test-model"],
    tokenTotals: { input: 0, output: 0 },
    provenance: [],
    visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-0000000000e2" },
    turns: [],
  } as unknown as SessionSeed;
}

/** Every (source, version, input file) the contract fixtures provide. */
function fixtureInputs(): { source: string; version: string; file: string }[] {
  const found: { source: string; version: string; file: string }[] = [];
  for (const source of readdirSync(FIXTURES)) {
    const sourceDir = join(FIXTURES, source);
    if (!statSync(sourceDir).isDirectory()) continue;
    for (const version of readdirSync(sourceDir)) {
      const versionDir = join(sourceDir, version);
      if (!statSync(versionDir).isDirectory()) continue;
      for (const session of readdirSync(versionDir)) {
        const inputDir = join(versionDir, session, "input");
        try {
          for (const file of readdirSync(inputDir)) found.push({ source, version, file: join(inputDir, file) });
        } catch {
          // Not every fixture directory has an input; those are covered by the
          // contract check rather than here.
        }
      }
    }
  }
  return found;
}

/** Ids as tools that do not use uuids actually write them. */
const AWKWARD = ["msg_01HQ8XABCDEF", "ses_9f2c1d", "42", "message-7", "01K5Z9J8QX"];

/**
 * Rewrites every id-shaped value in a JSON document to one that is not a uuid,
 * keeping the references between them intact.
 */
function rewriteIds(value: unknown, mapping: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteIds(entry, mapping));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const isIdKey = /(^|_|\b)(id|uuid)$/iu.test(key) || /^(parent_?uuid|parentId|parentID)$/iu.test(key);
      if (isIdKey && typeof entry === "string" && isUuid(entry)) {
        if (!mapping.has(entry)) mapping.set(entry, `${AWKWARD[mapping.size % AWKWARD.length]!}-${mapping.size}`);
        out[key] = mapping.get(entry)!;
      } else if (isIdKey && typeof entry === "string" && mapping.has(entry)) {
        out[key] = mapping.get(entry)!;
      } else {
        out[key] = rewriteIds(entry, mapping);
      }
    }
    return out;
  }
  return value;
}

/** Ids in a mapping's keys too, which is where ChatGPT keeps its nodes. */
function rewriteKeys(value: unknown, mapping: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteKeys(entry, mapping));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[mapping.get(key) ?? key] = rewriteKeys(entry, mapping);
    }
    return out;
  }
  return value;
}

function collectIds(parsed: { sessions: { id: string; turns: { id: string; parentId?: string | null; blocks: { id: string }[] }[] }[] }): string[] {
  const ids: string[] = [];
  for (const session of parsed.sessions) {
    ids.push(session.id);
    for (const turn of session.turns) {
      ids.push(turn.id);
      if (turn.parentId) ids.push(turn.parentId);
      for (const block of turn.blocks) ids.push(block.id);
    }
  }
  return ids;
}

const registry = new ParserRegistry();
const inputs = fixtureInputs();

describe("every id a parser emits is storable", () => {
  it("found the fixtures to run against", () => {
    expect(inputs.length, "no fixture inputs were discovered").toBeGreaterThan(10);
  });

  for (const input of inputs) {
    const label = `${input.source}/${input.version}`;

    it(`${label}: as the fixture is written`, () => {
      const parsed = registry.parse({ source: input.source, version: input.version, raw: readFileSync(input.file), seed: seed() });
      if (parsed.kind !== "parsed") return; // Detection is covered by the contract check.

      for (const id of collectIds(parsed)) {
        expect(isUuid(id), `${label} emitted "${id}", which a uuid column refuses`).toBe(true);
      }
    });

    // Only the text formats can be rewritten this way; SQLite fixtures are
    // covered by the hostile cases in turn-identity.test.ts instead.
    if (!/\.(json|jsonl)$/u.test(input.file)) continue;

    it(`${label}: when the source does not use uuids`, () => {
      const text = readFileSync(input.file, "utf8");
      const mapping = new Map<string, string>();
      const rewrite = (document: unknown): string => JSON.stringify(rewriteKeys(rewriteIds(document, mapping), mapping));
      // A fixture is either one pretty-printed document or a line per record,
      // and only trying tells them apart: a formatted object split on newlines
      // is not valid JSON on any single line.
      let rewritten: string;
      try {
        rewritten = rewrite(JSON.parse(text) as unknown);
      } catch {
        rewritten = text.trimEnd().split("\n")
          .map((line) => (line.trim().length === 0 ? line : rewrite(JSON.parse(line) as unknown)))
          .join("\n");
      }

      const parsed = registry.parse({ source: input.source, version: input.version, raw: Buffer.from(rewritten), seed: seed() });

      // The one format that must refuse rather than derive: a canonical bundle
      // is memoar's own export, and the point of re-importing one is that a
      // session keeps the identity it had. Deriving would silently renumber an
      // archive being moved between deployments.
      if (input.source === "canonical-bundle") {
        expect(parsed.kind, "a bundle with unstorable ids must be refused, not rewritten").toBe("unknown");
        expect(parsed.kind === "unknown" ? parsed.diagnostic : "").toContain("not a uuid");
        return;
      }
      if (parsed.kind !== "parsed") return;

      const ids = collectIds(parsed);
      expect(ids.length, `${label} produced nothing to check`).toBeGreaterThan(0);
      for (const id of ids) {
        expect(isUuid(id), `${label} passed through "${id}" from a source that does not use uuids`).toBe(true);
      }
    });
  }
});
