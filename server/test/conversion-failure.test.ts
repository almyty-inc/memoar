import { describe, expect, it } from "vitest";
import { ConversionService } from "../src/convert.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { InMemoryJobQueue, type ObjectStorage } from "../src/ingest.js";
import { DeterministicLexicalBackend, DisabledSemanticSearchProvider, PackService, SearchService } from "../src/search.js";

/** Object storage that refuses to store, which is the transient failure. */
class RefusingObjects implements ObjectStorage {
  put(): Promise<void> { return Promise.reject(new Error("s3 is unreachable")); }
  get(): Promise<Uint8Array> { return Promise.reject(new Error("s3 is unreachable")); }
  signedDownloadUrl(objectKey: string): Promise<string> { return Promise.resolve(`memory://${objectKey}`); }
  health(): Promise<void> { return Promise.resolve(); }
}

class WorkingObjects implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  put(objectKey: string, bytes: Uint8Array): Promise<void> { this.objects.set(objectKey, bytes); return Promise.resolve(); }
  get(objectKey: string): Promise<Uint8Array> {
    const bytes = this.objects.get(objectKey);
    return bytes ? Promise.resolve(bytes) : Promise.reject(new Error("missing"));
  }
  signedDownloadUrl(objectKey: string): Promise<string> { return Promise.resolve(`memory://${objectKey}`); }
  health(): Promise<void> { return Promise.resolve(); }
}

async function seeded(): Promise<DevArchiveStore> {
  const store = new DevArchiveStore();
  await store.saveSession(TEST_CONTEXT, TEST_SESSION);
  return store;
}

function serviceWith(store: DevArchiveStore, objects: ObjectStorage): ConversionService {
  const search = new SearchService(new DeterministicLexicalBackend(store), new DisabledSemanticSearchProvider());
  return new ConversionService(store, objects, new PackService(search, () => new Date("2026-08-21T00:00:00.000Z")), new InMemoryJobQueue());
}

describe("a conversion that fails", () => {
  /**
   * The queue is told, so the three attempts the job was given can be spent.
   *
   * `run` used to catch, save `failed`, and return normally. BullMQ therefore
   * recorded the job completed: the processed-jobs metric counted it a success,
   * the error aggregator never saw it, and the `attempts: 3` the job was
   * queued with could never be spent — so the first transient blip putting the
   * object became a permanent failure, for a request that a retry moments
   * later would have satisfied.
   */
  it("reaches the caller of run, rather than being reported as a completed job", async () => {
    const store = await seeded();
    const service = serviceWith(store, new RefusingObjects());
    const created = await service.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "claude-code", fallback: "fail" });

    await expect(
      service.run(TEST_CONTEXT, created.id as string),
      "a worker that is not told cannot retry, and nothing counts the failure",
    ).rejects.toThrow("s3 is unreachable");
  });

  /** And the job still records what happened, for the reader rather than the queue. */
  it("is still recorded as failed, with the reason", async () => {
    const store = await seeded();
    const service = serviceWith(store, new RefusingObjects());
    const created = await service.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "claude-code", fallback: "fail" });

    const job = await service.get(TEST_CONTEXT, created.id as string);
    expect(job.status, "a conversion left running for ever is the worse failure").toBe("failed");
    expect(job.report).toMatchObject({ error: "s3 is unreachable" });
  });

  /**
   * Creating the job is what the caller asked for, and it succeeded.
   *
   * Without a queue there is no worker, so the service runs the conversion in
   * the request. `run` raising must not turn a stored failure into a failed
   * request — the job exists and its status is the honest answer.
   */
  it("does not make creating the job fail when it runs inline", async () => {
    const store = await seeded();
    const service = serviceWith(store, new RefusingObjects());

    const created = await service.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "claude-code", fallback: "fail" });
    expect(created.status).toBe("failed");
  });
});

describe("what a conversion tells its caller", () => {
  /**
   * Not where the archive keeps the bytes.
   *
   * `get` spread the whole stored result, which carries `objectKey` —
   * `tenants/<tenantId>/conversions/<id>.json`. That published the archive's
   * own storage layout, and the tenant id inside it, to every caller of an
   * endpoint whose download is only ever reached through a signed URL. A
   * spread also publishes by default whatever is added to the result later.
   */
  it("never names the archive's own storage path", async () => {
    const store = await seeded();
    const objects = new WorkingObjects();
    const service = serviceWith(store, objects);
    const created = await service.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "claude-code", fallback: "fail" });

    const job = await service.get(TEST_CONTEXT, created.id as string);
    expect(job.status).toBe("ready");
    expect(job, "the storage key is the archive's business, not the caller's").not.toHaveProperty("objectKey");
    expect(JSON.stringify(job)).not.toContain("tenants/");
    expect(JSON.stringify(job)).not.toContain(TEST_CONTEXT.tenantId);

    // And the things a caller does need are still there.
    expect(job.resumeCommand).toBeTypeOf("string");
    expect(job.report).toBeDefined();
    // The download still resolves, through the signed URL rather than the key.
    expect((await service.download(TEST_CONTEXT, created.id as string)).url).toContain("tenants/");
  });
});
