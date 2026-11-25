import { describe, expect, it } from "vitest";
import type { ArchivedSession } from "../src/store/context.js";
import { boundedSearchDocument } from "../src/store/postgres/search-document.js";

function session(blocks: { kind: string; text?: string }[]): ArchivedSession {
  return {
    turns: [{ blocks: blocks.map((block, index) => ({ id: `b${index}`, ...block })) }],
  } as unknown as ArchivedSession;
}

describe("the search document", () => {
  it("takes tool output and thinking, the head of each, and prose whole", () => {
    const output = `npm ERR! missing script: test${"x".repeat(10_000)}TAIL-OF-OUTPUT`;
    const prose = `${"word ".repeat(3_000)}END-OF-PROSE`;
    const document = boundedSearchDocument(session([
      { kind: "text", text: prose },
      { kind: "tool_result", text: output },
      { kind: "thinking", text: "weighing whether the lockfile is stale" },
      { kind: "tool_call" },
    ]));
    expect(document).toContain("END-OF-PROSE");
    expect(document).toContain("npm ERR! missing script: test");
    expect(document).not.toContain("TAIL-OF-OUTPUT");
    expect(document).toContain("weighing whether the lockfile is stale");
  });

  it("finds a message written after a session's worth of huge tool outputs", () => {
    const outputs = Array.from({ length: 400 }, () => ({ kind: "tool_result", text: "y".repeat(50_000) }));
    const document = boundedSearchDocument(session([...outputs, { kind: "text", text: "the fix was in the importer" }]));
    expect(document).toContain("the fix was in the importer");
    expect(Buffer.byteLength(document, "utf8")).toBeLessThanOrEqual(1_000_000);
  });
});
