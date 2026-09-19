import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";

/**
 * Which parser produced a canonical session.
 *
 * Every session in every archive was stamped `parserVersion: "0.1.0"` — a
 * literal in the seed, kept whatever had actually parsed the bytes. The Claude
 * Code parser calls itself `claude-code:v1:0.3.0`, so the recorded version was
 * not merely uniform, it was wrong.
 *
 * It matters because reprocessing exists to replay a parser improvement over
 * what earlier versions produced, and `reprocess --tenant` cannot pick out the
 * sessions that need it if provenance says every one came from the same parser.
 */
const context: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000f1",
  userId: "0191cafe-0000-7000-8000-0000000000f2",
  scopes: ["ingest:write"],
  authType: "machine",
  machineId: "0191cafe-0000-7000-8000-0000000000f3",
};

/** One Claude Code session, in the shape the tool writes. */
function claudeCodeTranscript(): Uint8Array {
  const lines = [
    { type: "user", uuid: "11111111-1111-4111-8111-111111111111", parentUuid: null, sessionId: "native-session-1", cwd: "/work/project", gitBranch: "main", timestamp: "2026-09-09T11:00:00.000Z", message: { role: "user", content: "does provenance say which parser ran?" } },
    { type: "assistant", uuid: "22222222-2222-4222-8222-222222222222", parentUuid: "11111111-1111-4111-8111-111111111111", sessionId: "native-session-1", timestamp: "2026-09-09T11:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "It should." }] } },
  ];
  return new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"));
}

async function ingest(bytes: Uint8Array, source: string) {
  const store = new DevArchiveStore();
  const objects = new MemoryObjectStorage();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `raw/${sha256}`;
  await objects.put(objectKey, bytes);
  await store.saveRawArtifact(context, {
    id: "0191cafe-0000-7000-8000-0000000000f4",
    tenantId: context.tenantId,
    sessionIds: [],
    sha256,
    size: bytes.byteLength,
    objectKey,
    status: "stored",
    source,
    sourcePath: `provenance/${source}`,
    capturedAt: "2026-09-09T11:00:00.000Z",
    diagnostic: null,
  });
  const result = await new IngestPipeline(store, objects).process(context, sha256);
  const sessions = await Promise.all(result.sessionIds.map((id) => store.getSession(context, id)));
  return { result, sessions };
}

describe("the provenance of a parsed session", () => {
  it("records the parser that actually ran, by name and version", async () => {
    const { result, sessions } = await ingest(claudeCodeTranscript(), "claude-code");

    expect(result.status).toBe("parsed");
    const native = sessions[0]!.provenance.find((entry) => entry.kind === "native");
    expect(native?.parserVersion).toBe("claude-code:v1:0.3.0");
  });

  it("keeps no placeholder from the seed", async () => {
    // The seed has to put something there before a parser has been chosen. If
    // that survives, the field is decorative.
    const { sessions } = await ingest(claudeCodeTranscript(), "claude-code");

    for (const session of sessions) {
      for (const entry of session!.provenance) {
        expect(entry.parserVersion, "a seed placeholder reached the archive").not.toBe("pending");
        expect(entry.parserVersion, "the literal that was stamped on everything").not.toBe("0.1.0");
      }
    }
  });

  it("names the source it came from, so two parsers are distinguishable", async () => {
    const { sessions } = await ingest(claudeCodeTranscript(), "claude-code");
    const native = sessions[0]!.provenance.find((entry) => entry.kind === "native");

    expect(native?.parserVersion).toContain("claude-code");
  });
});
