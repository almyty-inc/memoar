import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArchivedSession, TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";

/*
  What a parse that fails leaves behind.

  The dev archive holds 222 artifacts sitting on `stored` two days after
  capture, and 49 on `failed` — 32 of those reading "deadlock detected", which
  is two workers saving the same conversation at once and nothing worse. Both
  numbers come from the same hole: the pipeline only guarded the session loop,
  and only to swallow it, so a transient failure became permanent and an
  earlier one became invisible.
*/

const context: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000f1",
  userId: "0191cafe-0000-7000-8000-0000000000f2",
  scopes: ["ingest:write"],
  authType: "machine",
  machineId: "0191cafe-0000-7000-8000-0000000000f3",
};

async function seeded(): Promise<{ store: DevArchiveStore; objects: MemoryObjectStorage; sha256: string }> {
  const store = new DevArchiveStore();
  const objects = new MemoryObjectStorage();
  const bytes = await readFile(resolve(process.cwd(), "../contracts/fixtures/cursor/v3/session-1/input/native.sqlite3"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `tenants/${context.tenantId}/raw/${sha256}`;
  await objects.put(objectKey, bytes);
  await store.saveRawArtifact(context, {
    id: "0191cafe-0000-7000-8000-0000000000f4",
    tenantId: context.tenantId,
    sessionIds: [],
    sha256,
    size: bytes.byteLength,
    objectKey,
    status: "stored",
    source: "cursor",
    sourcePath: "failure/native.sqlite3",
    capturedAt: "2026-09-17T16:30:00.000Z",
    diagnostic: null,
  });
  return { store, objects, sha256 };
}

describe("a parse job that fails", () => {
  it("leaves the artifact failed with a diagnostic when the bytes cannot be fetched", async () => {
    // Nothing between the upload and the session loop was guarded, so an object
    // store that could not serve the bytes left the artifact on `stored` with a
    // null diagnostic — indistinguishable from an artifact nobody has queued
    // yet, and counted by neither.
    const { store, objects, sha256 } = await seeded();
    const unreadable = {
      put: objects.put.bind(objects),
      get: () => Promise.reject(new Error("object_store_unreachable")),
    } as unknown as MemoryObjectStorage;

    await expect(new IngestPipeline(store, unreadable).process(context, sha256))
      .rejects.toThrow("object_store_unreachable");

    const artifact = await store.getRawArtifact(context, sha256);
    expect(artifact!.status, "an artifact that failed to parse must not read as freshly stored").toBe("failed");
    expect(artifact!.diagnostic).toContain("object_store_unreachable");
    const unparsed = await store.countUnparsedArtifactsBySource(context);
    expect(unparsed.map((item) => ({ source: item.source, artifacts: item.artifacts })), "and it must reach the one report a person reads")
      .toEqual([{ source: "cursor", artifacts: 1 }]);
    expect(unparsed[0]!.diagnostic).toContain("object_store_unreachable");
  });

  it("raises a persistence failure so the queue spends the attempts it was given", async () => {
    // The manifest queues every parse with `attempts: 5`. Returning
    // `{ status: "failed" }` instead of throwing made BullMQ record a completed
    // job, so none of the five were ever spent and a deadlock between two
    // workers became a permanent failure for that transcript.
    const { store, objects, sha256 } = await seeded();
    let saves = 0;
    const deadlocking = Object.create(store) as DevArchiveStore;
    deadlocking.saveSession = (tenant: TenantContext, session: ArchivedSession): Promise<void> => {
      saves += 1;
      if (saves === 1) return Promise.reject(new Error("deadlock detected"));
      return DevArchiveStore.prototype.saveSession.call(store, tenant, session);
    };
    const pipeline = new IngestPipeline(deadlocking, objects);

    await expect(pipeline.process(context, sha256), "a transient failure must reach the queue").rejects.toThrow("deadlock detected");
    expect((await store.getRawArtifact(context, sha256))!.status).toBe("failed");

    // What the queue's second attempt does, and the reason raising it matters.
    const retried = await pipeline.process(context, sha256);
    expect(retried.status).toBe("parsed");
    const artifact = await store.getRawArtifact(context, sha256);
    expect(artifact!.status).toBe("parsed");
    expect(artifact!.diagnostic, "a parse that succeeded must not still be explaining itself").toBeNull();
  });
});
