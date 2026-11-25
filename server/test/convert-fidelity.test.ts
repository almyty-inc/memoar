import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContentBlock, Session } from "../libs/canonical/src/generated.js";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";
import { ClaudeCodeWriter } from "../src/convert/native-writers.js";

const fixture = resolve(process.cwd(), "../contracts/fixtures/claude-code/v1/rich-1");

function parse(raw: Uint8Array, seed: SessionSeed): Session {
  const result = new ParserRegistry().parse({ source: "claude-code", version: "v1", raw, seed });
  if (result.kind !== "parsed") throw new Error(result.diagnostic);
  return result.sessions[0]!;
}

/** What a block says, without the ids a re-parse is free to mint anew. */
function content(session: Session): Partial<ContentBlock>[] {
  return session.turns.flatMap((turn) => turn.blocks).map(({ kind, text, name, callId, mimeType, artifactRef, data }) =>
    JSON.parse(JSON.stringify({ kind, text, name, callId, mimeType, artifactRef, data })) as Partial<ContentBlock>);
}

describe("converting a session keeps what the parse kept", () => {
  it("writes tool output, error flags, signatures, redacted reasoning and images back out and reads them again", () => {
    const expected = JSON.parse(readFileSync(resolve(fixture, "expected.canonical.json"), "utf8")) as Session;
    const seed = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "turns")) as SessionSeed;
    const original = parse(readFileSync(resolve(fixture, "input/session.jsonl")), seed);

    const bundle = new ClaudeCodeWriter().write(original);
    const again = parse(bundle.files[0]!.bytes, seed);

    // System notes (a compaction boundary, a summary) have no Claude Code
    // block and degrade to attributed text by design, reported as such.
    const kept = (session: Session) => content(session).filter((block) => block.kind !== "system" && !block.text?.startsWith("[Memoar system]"));
    expect(kept(again)).toEqual(kept(original));
    expect(new Set(bundle.report.degraded.map((entry) => entry.kind))).toEqual(new Set(["system"]));
  });
});
