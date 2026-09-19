import { describe, expect, it } from "vitest";
import { ConversionService } from "../src/convert.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { BullMqQueueAdapter, MemoryObjectStorage, type ObjectStorage } from "../src/ingest.js";
import { handlePipelineJob, jobContext, type PipelineJob } from "../src/pipeline-jobs.js";
import { DeterministicLexicalBackend, DisabledSemanticSearchProvider, PackService, SearchService } from "../src/search.js";

/** Stands in for BullMQ: records what was queued without needing Redis. */
class RecordingQueue extends BullMqQueueAdapter {
  readonly queued: PipelineJob[] = [];
  readonly options: Record<string, unknown>[] = [];
  constructor() {
    super({
      add: (name, data, options) => {
        // BullMQ refuses a custom id containing a colon, and a fake that accepts
        // one lets a job id through here that the real queue rejects with a 500.
        if (options.jobId.includes(":")) return Promise.reject(new Error("Custom Id cannot contain :"));
        this.queued.push({ name, data });
        this.options.push({ ...options });
        return Promise.resolve(undefined);
      },
    });
  }
}

function services(): { conversions: ConversionService; queue: RecordingQueue; store: DevArchiveStore; objects: ObjectStorage } {
  const store = new DevArchiveStore();
  const search = new SearchService(new DeterministicLexicalBackend(store), new DisabledSemanticSearchProvider());
  const objects = new MemoryObjectStorage();
  const queue = new RecordingQueue();
  return {
    conversions: new ConversionService(store, objects, new PackService(search, () => new Date("2026-08-21T00:00:00.000Z")), queue),
    queue,
    store,
    objects,
  };
}

describe("queued pipeline jobs", () => {
  it("accepts a conversion without doing the work in the request", async () => {
    // Converting is processor work: done inline, twenty conversions of a
    // 2000-turn session took twenty times as long as one and starved the
    // health endpoint that decides whether the container is alive.
    const { conversions, queue, store } = services();
    await store.saveSession(TEST_CONTEXT, TEST_SESSION);

    const accepted = await conversions.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "codex", fallback: "injection" });

    expect(accepted.status, "the contract has always said queued").toBe("queued");
    expect(accepted.resumeCommand, "nothing is converted yet, so nothing may claim to be").toBeUndefined();
    expect(queue.queued).toHaveLength(1);
    expect(queue.queued[0]!.name).toBe("convert");
    expect(queue.queued[0]!.data.jobId).toBe(accepted.id);
  });

  it("completes that job through the same dispatcher the worker runs", async () => {
    const { conversions, queue, store } = services();
    await store.saveSession(TEST_CONTEXT, TEST_SESSION);
    const accepted = await conversions.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "codex", fallback: "injection" });

    const pipeline = { process: () => Promise.reject(new Error("not this job")) } as never;
    await handlePipelineJob(queue.queued[0]!, { pipeline, conversions });

    const finished = await conversions.get(TEST_CONTEXT, accepted.id as string);
    expect(finished.status).toBe("ready");
    expect(finished.resumeCommand).toContain("codex");
  });

  it("lets a job that spent every attempt fall out of Redis, so its id can be used again", async () => {
    /*
      Every job here is given a deterministic id, so that an agent re-offering a
      growing transcript queues one parse rather than fifty. BullMQ implements
      that by refusing to add a job whose key already exists — and a job that
      has exhausted its attempts keeps its key just as much as a running one
      does. With `removeOnFail` unset, which is to say kept for ever, the
      artifact behind a five-times-failed parse becomes permanently unqueueable:
      the agent goes on sending manifests, the receipt goes on saying accepted,
      and nothing runs for that transcript again while the Redis instance lives.
    */
    const { conversions, queue, store } = services();
    await store.saveSession(TEST_CONTEXT, TEST_SESSION);
    await conversions.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "codex", fallback: "injection" });

    const options = queue.options[0]!;
    expect(options.attempts, "a job with no attempts has nothing to exhaust").toBeTruthy();
    const removeOnFail = options.removeOnFail as { age?: number; count?: number } | undefined;
    expect(removeOnFail, "a failed job kept for ever holds its own id hostage").toBeDefined();
    expect(removeOnFail!.age).toBeGreaterThan(0);
    expect(removeOnFail!.age, "and kept too briefly, nobody ever sees why it failed").toBeLessThanOrEqual(7 * 86_400);
  });

  it("acts for the tenant that queued the job, never for the worker", () => {
    // The worker runs with no user of its own; taking the tenant from anywhere
    // but the job would let one tenant's queued work read another's archive.
    expect(jobContext({ name: "convert", data: { tenantId: "t", userId: "u", machineId: "m" } }))
      .toEqual({ tenantId: "t", userId: "u", scopes: ["*"], authType: "machine", machineId: "m" });
    expect(() => jobContext({ name: "convert", data: { userId: "u" } })).toThrow("invalid_tenant_job_context");
  });

  it("refuses a job it does not know rather than silently doing nothing", async () => {
    const { conversions } = services();
    const pipeline = { process: () => Promise.resolve({ status: "parsed", sessionIds: [] }) } as never;
    await expect(handlePipelineJob({ name: "reticulate", data: { tenantId: "t", userId: "u" } }, { pipeline, conversions }))
      .rejects.toThrow("unsupported_pipeline_job:reticulate");
    await expect(handlePipelineJob({ name: "parse", data: { tenantId: "t", userId: "u" } }, { pipeline, conversions }))
      .rejects.toThrow("parse_job_missing_sha256");
  });
});
