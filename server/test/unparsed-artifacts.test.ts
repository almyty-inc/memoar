import { describe, expect, it } from "vitest";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import type { TenantContext } from "../src/archive-store.js";

const OWNER: TenantContext = { tenantId: "t-1", userId: "u-1", scopes: ["*"], authType: "browser" };
const NEIGHBOUR: TenantContext = { tenantId: "t-2", userId: "u-2", scopes: ["*"], authType: "browser" };

function artifact(tenantId: string, sha256: string, source: string, status: string, diagnostic: string | null = null) {
  return {
    tenantId, id: sha256, sha256, source, sourcePath: `/w/${sha256}.jsonl`, size: 10,
    capturedAt: "2026-09-01T00:00:00.000Z", objectKey: `k/${sha256}`,
    status, diagnostic, sessionIds: [],
  } as unknown as Parameters<DevArchiveStore["saveRawArtifact"]>[1];
}

/**
 * Capture can fail without failing.
 *
 * Bytes the archive cannot parse are kept on purpose, so a parser written later
 * can still read them — but nothing ever said so, and that silence is exactly
 * what hides a pattern pointed at the wrong directory. Two sources were found
 * doing it, one archiving an editor's terminal history rather than its
 * conversations, for as long as the pattern had existed.
 */
describe("artifacts that never became a session", () => {
  it("counts them per tool, worst first", async () => {
    const store = new DevArchiveStore();
    await store.saveRawArtifact(OWNER, artifact(OWNER.tenantId, "a".repeat(64), "zed", "unknown_format", "no threads table"));
    await store.saveRawArtifact(OWNER, artifact(OWNER.tenantId, "b".repeat(64), "zed", "unknown_format", "no threads table"));
    await store.saveRawArtifact(OWNER, artifact(OWNER.tenantId, "c".repeat(64), "copilot", "failed", "parser threw"));
    await store.saveRawArtifact(OWNER, artifact(OWNER.tenantId, "d".repeat(64), "claude-code", "parsed"));

    const counted = await store.countUnparsedArtifactsBySource(OWNER);
    expect(counted).toEqual([
      { source: "zed", artifacts: 2, diagnostic: "no threads table" },
      { source: "copilot", artifacts: 1, diagnostic: "parser threw" },
    ]);
  });

  it("says nothing when everything was read", async () => {
    const store = new DevArchiveStore();
    await store.saveRawArtifact(OWNER, artifact(OWNER.tenantId, "e".repeat(64), "claude-code", "parsed"));
    expect(await store.countUnparsedArtifactsBySource(OWNER)).toEqual([]);
  });

  it("counts only this account's", async () => {
    const store = new DevArchiveStore();
    await store.saveRawArtifact(OWNER, artifact(OWNER.tenantId, "f".repeat(64), "zed", "unknown_format"));
    await store.saveRawArtifact(NEIGHBOUR, artifact(NEIGHBOUR.tenantId, "g".repeat(64), "zed", "unknown_format"));
    await store.saveRawArtifact(NEIGHBOUR, artifact(NEIGHBOUR.tenantId, "h".repeat(64), "goose", "unknown_format"));

    expect(await store.countUnparsedArtifactsBySource(OWNER)).toEqual([
      { source: "zed", artifacts: 1, diagnostic: null },
    ]);
  });
});
