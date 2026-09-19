import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConversionEngine, serializedBundleObject } from "../src/convert.js";
import { encodeClaudeWorkspace } from "../src/convert/workspace-name.js";
import { TEST_SESSION } from "./fixtures/archive.js";

/**
 * One session-conversion contract, in two languages.
 *
 * `memory-dialect-parity.test.ts` holds the memory half together. The session
 * half had nothing, and drifted twice: the archive built an Antigravity
 * database with tables of its own invention while the materializer validated
 * the observed schema, so every `antigravity-cli` conversion was refused on the
 * user's machine and nowhere else; and the archive never bounded the workspace
 * directory name, which the materializer's own copy of the encoder has bounded
 * since the day a deep workspace died with `File name too long`.
 *
 * Both failures are invisible to either side alone. They are only visible to a
 * test that reads the other half.
 */
async function read(relativePath: string): Promise<string> {
  return readFile(resolve(process.cwd(), relativePath), "utf8");
}

const TARGETS = "../agent/crates/memoar-materializer/src/target.rs";
const WORKSPACE_NAMES = "../contracts/fixtures/claude-workspace-names.json";
const BUNDLE = "../contracts/fixtures/session-conversion-bundle.json";

interface SerializedBundle {
  target: string;
  sessionId: string;
  files: { path: string; mediaType: string; base64: string; sha256: string; size: number }[];
  resumeCommand: string;
  bundleSha256: string;
}

/** Reads one row per table out of a database held as bytes. */
function inspectDatabase(contents: Uint8Array): { tables: string[]; trajectory: unknown; conversion: unknown } {
  const directory = mkdtempSync(join(tmpdir(), "memoar-parity-"));
  const path = join(directory, "brain.db");
  writeFileSync(path, contents);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      tables: (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
        .map((row) => row.name),
      trajectory: database.prepare("SELECT trajectory_id, cascade_id FROM trajectory_meta").get(),
      conversion: database.prepare("SELECT id, workspace_path, title, contract_version FROM memoar_conversion").get(),
    };
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("the targets a session may be converted into", () => {
  it("are the ones the materializer will write", async () => {
    const source = await read(TARGETS);
    const wireNames = [...source.matchAll(/Self::\w+ => "([a-z-]+)",/gu)].map((match) => match[1]!);
    expect(wireNames.length, "no target wire names were parsed; has as_str changed shape?").toBe(3);
    const engine = new ConversionEngine();
    for (const name of wireNames) {
      expect(engine.supportsNatively(name), `the materializer accepts ${name} and the archive cannot build it`).toBe(true);
    }
    // And nothing the archive claims to build natively that the machine would
    // refuse as an unsupported target.
    for (const target of ["claude-code", "codex", "antigravity-cli"]) {
      expect(wireNames, `the archive builds ${target} and the materializer refuses it`).toContain(target);
    }
  });
});

describe("the directory a Claude Code conversion lands in", () => {
  it("is the one the materializer's encoder computes", async () => {
    const { cases } = JSON.parse(await read(WORKSPACE_NAMES)) as { cases: { workspace: string; encoded: string }[] };
    expect(cases.length).toBeGreaterThan(4);
    for (const example of cases) {
      expect(encodeClaudeWorkspace(example.workspace), `workspace ${JSON.stringify(example.workspace)}`)
        .toBe(example.encoded);
      // The cap is on bytes. Every character the encoder emits is ASCII, which
      // is why a multi-byte workspace cannot smuggle a longer name past it.
      expect(Buffer.byteLength(example.encoded, "utf8")).toBe(example.encoded.length);
      expect(Buffer.byteLength(example.encoded, "utf8")).toBeLessThanOrEqual(255);
    }
  });

  it("is short enough for the filesystem that has to hold it", () => {
    const deep = { ...TEST_SESSION, workspace: { ...TEST_SESSION.workspace, path: `/Users/person/${"nested-directory/".repeat(30)}project` } };
    const bundle = new ConversionEngine().convert(deep, "claude-code", "fail");
    for (const component of bundle.files[0]!.path.slice(2).split("/")) {
      expect(Buffer.byteLength(component, "utf8"), `component ${component} would fail the write with ENAMETOOLONG`)
        .toBeLessThanOrEqual(255);
    }
  });
});

describe("the digest the materializer recomputes", () => {
  it("orders the report's keys by bytes, the way the other half sorts", () => {
    // `bundle.rs::canonical_json` sorts Rust Strings, which is a byte compare.
    // A locale collation puts `a` before `Z`; bytes put `Z` first. The two
    // agree on today's keys and on nothing guaranteed, and a disagreement is
    // every conversion failing on every machine and none in CI.
    const good = new ConversionEngine().convert(TEST_SESSION, "claude-code", "fail");
    const report = { Z: 1, a: 2, "-": 3, B: 4 } as unknown as typeof good.report;
    const serialized = serializedBundleObject({ ...good, report }) as unknown as { report: Record<string, unknown> };
    expect(Object.keys(serialized.report)).toEqual(["-", "B", "Z", "a"]);
  });
});

/**
 * A bundle is checked before it is stored, not after it is downloaded.
 *
 * Everything the materializer refuses, it refuses on somebody's laptop: the job
 * says `ready`, the pre-signed URL is handed out, and the write fails where no
 * test runs. Both drifts this file exists for were of that shape.
 */
describe("a bundle the machine would refuse", () => {
  const engine = new ConversionEngine();

  it("is refused here instead, before it is stored", () => {
    const good = engine.convert(TEST_SESSION, "claude-code", "fail");
    expect(() => serializedBundleObject(good)).not.toThrow();

    const cases: [string, string][] = [
      [`~/.config/${TEST_SESSION.id}.jsonl`, "conversion_path_outside_target"],
      [`.claude/projects/p/${TEST_SESSION.id}.jsonl`, "conversion_path_outside_target"],
      ["~/.claude/projects/p/other.jsonl", "conversion_path_missing_session_id"],
      [`~/.claude/projects/../${TEST_SESSION.id}.jsonl`, "conversion_path_not_normal"],
      [`~/.claude/projects/${"n".repeat(256)}/${TEST_SESSION.id}.jsonl`, "conversion_path_component_too_long"],
    ];
    for (const [path, code] of cases) {
      const bundle = { ...good, files: [{ ...good.files[0]!, path }] };
      expect(() => serializedBundleObject(bundle), path).toThrow(code);
    }
  });

  it("does not stop an injection prelude, which is pasted and never written", () => {
    const fallback = engine.convert(TEST_SESSION, "some-other-agent", "injection");
    expect(fallback.files[0]!.path).toBe(`memoar-injection-${TEST_SESSION.id}.md`);
    expect(() => serializedBundleObject(fallback)).not.toThrow();
  });
});

/**
 * The other half of this one is
 * `tests::parity::materializes_the_committed_server_bundle`, which writes this
 * exact file to disk with the real materializer. Neither side can move alone:
 * change what the archive builds and this test fails, change what the machine
 * accepts and that one does.
 */
describe("the Antigravity bundle the archive writes", () => {
  it("is the database the materializer validates", async () => {
    const fixture = JSON.parse(await read(BUNDLE)) as SerializedBundle;
    const built = serializedBundleObject(new ConversionEngine().convert(TEST_SESSION, "antigravity-cli", "fail")) as unknown as SerializedBundle;

    expect(built.files.map((file) => file.path)).toEqual(fixture.files.map((file) => file.path));
    expect(built.files.map((file) => file.mediaType)).toEqual(fixture.files.map((file) => file.mediaType));
    expect(built.resumeCommand).toBe(fixture.resumeCommand);
    // Everything but the database compares byte for byte; SQLite's page layout
    // is not a promise any node release makes, so the database is compared by
    // what it holds.
    for (const [index, file] of built.files.entries()) {
      if (file.path.endsWith(".db")) continue;
      expect(file.base64, `${file.path} drifted from the committed bundle`).toBe(fixture.files[index]!.base64);
    }

    const database = built.files.find((file) => file.path.endsWith(".db"))!;
    const observed = inspectDatabase(Buffer.from(database.base64, "base64"));
    expect(observed.tables, "the materializer refuses a brain database without trajectory_meta")
      .toEqual(inspectDatabase(Buffer.from(fixture.files.find((file) => file.path.endsWith(".db"))!.base64, "base64")).tables);
    expect(observed.tables).toContain("trajectory_meta");
    expect(observed.trajectory).toMatchObject({ trajectory_id: TEST_SESSION.id, cascade_id: TEST_SESSION.id });
    expect(observed.conversion).toMatchObject({ id: TEST_SESSION.id, workspace_path: TEST_SESSION.workspace.path });
  });
});
