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

    // Two things change by design. System notes (a compaction boundary, a
    // summary) are Claude Code's own harness context and are dropped, reported
    // as such. A file attached with an @-mention is written back as the
    // person's text, since its own record type is Claude Code's and the other
    // targets have no equivalent.
    const mention = original.turns.flatMap((turn) => turn.blocks).find((block) => block.kind === "attachment" && block.artifactRef);
    const kept = (session: Session) => content(session).filter((block) =>
      block.kind !== "system" && block.artifactRef === undefined && block.text !== `${mention?.name}\n${mention?.text}`);
    expect(kept(again)).toEqual(kept(original));
    expect(content(again)).toContainEqual({ kind: "text", text: `${mention!.name}\n${mention!.text}` });
    expect(new Set(bundle.report.dropped.map((entry) => entry.reason))).toEqual(new Set(["source_harness_context"]));
    expect(bundle.report.degraded).toEqual([]);
  });
});
