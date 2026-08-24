import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";

const context: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000e1",
  userId: "0191cafe-0000-7000-8000-0000000000e2",
  scopes: ["ingest:write"],
  authType: "machine",
  machineId: "0191cafe-0000-7000-8000-0000000000e3",
};

function multiComposerDatabase(): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "memoar-grouped-"));
  const path = join(directory, "state.vscdb");
  try {
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
    const insert = database.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    for (const name of ["alpha", "beta"]) {
      insert.run(`composerData:native-${name}`, JSON.stringify({
        composerId: `native-${name}`,
        name: `Composer ${name}`,
        conversation: [{
          bubbleId: `0191cafe-0000-7000-8000-00000000${name === "alpha" ? "e4" : "e5"}00`,
          parentBubbleId: null,
          role: "user",
          createdAt: "2026-08-20T00:00:00.000Z",
          blocks: [{ id: `0191cafe-0000-7000-8000-00000000${name === "alpha" ? "e4" : "e5"}01`, kind: "text", text: `hello from ${name}` }],
        }],
      }));
    }
    database.close();
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("grouped zero-to-many ingest", () => {
  it("parses one artifact into many sessions with authoritative artifact-session joins and stable reprocessing", async () => {
    const store = new DevArchiveStore();
    const objects = new MemoryObjectStorage();
    const bytes = multiComposerDatabase();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `tenants/${context.tenantId}/raw/${sha256}`;
    await objects.put(objectKey, bytes);
    await store.saveRawArtifact(context, {
      id: "0191cafe-0000-7000-8000-0000000000e6",
      tenantId: context.tenantId,
      sessionIds: [],
      sha256,
      size: bytes.byteLength,
      objectKey,
      status: "stored",
      source: "cursor",
      sourcePath: "grouped/state.vscdb",
      capturedAt: "2026-08-20T00:00:00.000Z",
      diagnostic: null,
    });
    const pipeline = new IngestPipeline(store, objects);

    const first = await pipeline.process(context, sha256);
    expect(first.status).toBe("parsed");
    expect(first.sessionIds).toHaveLength(2);
    expect(new Set(first.sessionIds).size).toBe(2);

    const artifact = await store.getRawArtifact(context, sha256);
    expect(artifact!.sessionIds).toEqual(first.sessionIds);

    const sessions = await Promise.all(first.sessionIds.map((id) => store.getSession(context, id)));
    expect(sessions.map((session) => session!.source.nativeSessionId).sort()).toEqual(["native-alpha", "native-beta"]);
    expect(sessions.map((session) => session!.title).sort()).toEqual(["Composer alpha", "Composer beta"]);

    const second = await pipeline.process(context, sha256);
    expect(second.sessionIds).toEqual(first.sessionIds);
  });
});
