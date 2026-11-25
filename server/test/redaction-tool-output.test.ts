import { describe, expect, it } from "vitest";
import type { SessionSeed } from "../libs/parsers/src/index.js";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { SecretScanner } from "../src/ingest/detection.js";
import { applyRedactionProjection } from "../src/redaction.js";
import type { ArchivedSession } from "../src/store/context.js";

// Assembled at run time so no credential-shaped literal sits in the repository.
const FAKE_KEY = ["AKIA", "FIXTUREONLY", "00000"].join("");

const seed: SessionSeed = {
  id: "0191cafe-0000-7000-8000-00000000a001",
  source: { vendor: "anthropic", tool: "claude-code", version: "v1", machineId: "0191cafe-0000-7000-8000-00000000a002" },
  workspace: { path: "/workspace/redaction" },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  title: "Redaction of tool output",
  models: [],
  tokenTotals: { input: 0, output: 0 },
  provenance: [{ kind: "native", capturedAt: "2026-08-20T00:00:00.000Z" }],
  visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-00000000a003" },
};

function transcript(): Buffer {
  const line = (uuid: string, parent: string | null, message: unknown) =>
    JSON.stringify({ uuid, parentUuid: parent, sessionId: "redaction", type: "user", timestamp: "2026-08-20T00:00:00.000Z", message });
  return Buffer.from([
    line("0191cafe-0000-7000-8000-00000000a011", null, { role: "assistant", content: [
      { type: "thinking", thinking: `I should not repeat ${FAKE_KEY} anywhere`, signature: "c2ln" },
      { type: "tool_use", id: "toolu_env", name: "Bash", input: { command: "cat .env" } },
    ] }),
    line("0191cafe-0000-7000-8000-00000000a012", "0191cafe-0000-7000-8000-00000000a011", { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_env", content: [{ type: "text", text: `AWS_ACCESS_KEY_ID=${FAKE_KEY}` }, { type: "text", text: "REGION=eu-west-1" }] },
      { type: "tool_result", tool_use_id: "toolu_env", content: `export KEY=${FAKE_KEY}` },
    ] }),
  ].join("\n"));
}

describe("secrets in tool output", () => {
  const raw = transcript();
  const result = new ParserRegistry().parse({ source: "claude-code", version: "v1", raw, seed });
  if (result.kind !== "parsed") throw new Error(result.diagnostic);
  const session = { ...result.sessions[0]!, redactionStatus: "findings" } as ArchivedSession;

  it("are found by the scanner, which reads the raw artifact", () => {
    expect(new SecretScanner().scan(raw).length).toBeGreaterThanOrEqual(3);
  });

  it("are now stored where a projection can mask them, and every copy is masked", () => {
    // The tool output used to be dropped, so there was nothing to mask. It is
    // kept now, in text, and the projection has to reach it there and in data.
    const parsed = JSON.stringify(session);
    expect(parsed).toContain(FAKE_KEY);
    const projected = JSON.stringify(applyRedactionProjection(session));
    expect(projected).not.toContain(FAKE_KEY);
    expect(projected).toContain("REGION=eu-west-1");
  });
});
