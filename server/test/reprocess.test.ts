import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";

const context: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000a1",
  userId: "0191cafe-0000-7000-8000-0000000000a2",
  scopes: ["ingest:write"],
  authType: "machine",
  machineId: "0191cafe-0000-7000-8000-0000000000a3",
};

async function seededPipeline(): Promise<{ pipeline: IngestPipeline; store: DevArchiveStore; sha256: string }> {
  const store = new DevArchiveStore();
  const objects = new MemoryObjectStorage();
  const bytes = await readFile(resolve(process.cwd(), "../contracts/fixtures/cursor/v3/session-1/input/native.sqlite3"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `tenants/${context.tenantId}/raw/${sha256}`;
  await objects.put(objectKey, bytes);
  await store.saveRawArtifact(context, {
    id: "0191cafe-0000-7000-8000-0000000000a4",
    tenantId: context.tenantId,
    sessionIds: [],
    sha256,
    size: bytes.byteLength,
    objectKey,
    status: "stored",
    source: "cursor",
    sourcePath: "reprocess/native.sqlite3",
    capturedAt: "2026-08-18T00:00:00.000Z",
    diagnostic: null,
  });
  return { pipeline: new IngestPipeline(store, objects), store, sha256 };
}

describe("reprocess idempotency", () => {
  it("maps the same native identity to one canonical session across runs and preserves user annotations", async () => {
    const { pipeline, store, sha256 } = await seededPipeline();

    const first = await pipeline.process(context, sha256);
    expect(first.status).toBe("parsed");
    expect(first.sessionIds).toHaveLength(1);

    const note = await store.createAnnotation(context, {
      sessionId: first.sessionIds[0]!,
      kind: "note",
      value: { text: "operator note that must survive reprocessing" },
    });

    const second = await pipeline.process(context, sha256);
    expect(second.status).toBe("parsed");
    expect(second.sessionIds).toEqual(first.sessionIds);

    const sessions = await store.listSessions(context, { limit: 50 });
    expect(sessions.items.filter((session) => session.source.tool === "cursor")).toHaveLength(1);

    const firstRun = await store.getSession(context, first.sessionIds[0]!);
    expect(firstRun?.turns.length).toBeGreaterThan(0);

    const annotations = await store.listAnnotations(context, first.sessionIds[0]);
    expect(annotations.some((annotation) => annotation.id === note.id)).toBe(true);
    const masks = annotations.filter((annotation) => annotation.kind === "redaction_mask");
    const uniqueMasks = new Set(masks.map((annotation) => JSON.stringify(annotation.value)));
    expect(masks.length).toBe(uniqueMasks.size);
  });
});
