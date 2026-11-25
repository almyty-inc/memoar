import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session } from "../libs/canonical/src/generated.js";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";
import { FormatDetector } from "../src/ingest/format-detection.js";

/**
 * Detection run the way the capture agent runs it.
 *
 * The agent sends `x-memoar-source: <tool>` and no version
 * (agent/crates/memoar-daemon/src/transport.rs), so the server has to work the
 * version out from the bytes. The fixture tests in parsers.test.ts name the
 * version themselves and never touched this path, which is how every real
 * Antigravity transcript came to be refused while all of them passed.
 *
 * So every fixture's raw input goes through the detector with the bare source
 * as its only header, must come out as the version the fixture is filed under,
 * and must then parse. A parser that learns a format the detector does not
 * recognise fails here, in CI, instead of on somebody's archive.
 */
interface ManifestEntry {
  source: string;
  version: string;
  fixture: string;
  input: string;
  expected: string;
}

const repository = resolve(process.cwd(), "..");
const manifest = JSON.parse(readFileSync(resolve(repository, "contracts/fixtures/manifest.json"), "utf8")) as { fixtures: ManifestEntry[] };
const detector = new FormatDetector();

function seedFrom(expected: string): SessionSeed {
  const session = JSON.parse(readFileSync(resolve(repository, expected), "utf8")) as Session;
  return Object.fromEntries(Object.entries(session).filter(([key]) => key !== "turns")) as SessionSeed;
}

describe("format detection with only the header the agent sends", () => {
  it.each(manifest.fixtures.map((entry) => [`${entry.source}/${entry.version}/${entry.fixture}`, entry] as const))(
    "%s is detected as its own version and parses",
    (_name, entry) => {
      const raw = readFileSync(resolve(repository, entry.input));
      const format = detector.detect(entry.source, raw);
      expect(format).toEqual({ source: entry.source, version: entry.version });
      const result = new ParserRegistry().parse({ ...format, raw, seed: seedFrom(entry.expected) });
      expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    },
  );

  it("has a fixture for every source the agent captures", () => {
    // A connector with no fixture would be outside the loop above, which is
    // exactly the blind spot this file exists to close.
    const withFixtures = new Set(manifest.fixtures.map((entry) => entry.source));
    const missing = new ParserRegistry().connectors().filter((source) => !withFixtures.has(source));
    expect(missing).toEqual([]);
  });
});
