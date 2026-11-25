import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import {
  ArtifactSettler, DEFAULT_SETTLE_DELAY_MS, InMemoryJobQueue, IngestService, MemoryObjectStorage, parseJobId, settleDelayMs, settleJobId,
} from "../src/ingest.js";
import { handlePipelineJob } from "../src/pipeline-jobs.js";

/*
  An upload the archive holds and never parses.

  The parse is queued by the manifest, and the agent sends the manifest after a
  whole pass of up to 256 uploads. On dev, 728 uploads arrived in three passes
  of 256, 256 and 216, and the longest any of them waited for its parse job was
  148 seconds, so a few hundred `stored` artifacts with no job is what a pass in
  flight looks like. What nothing covered was the pass that never finishes: an
  agent killed, asleep or out of disk between upload and manifest, or one whose
  manifest failed eight times and was given up on. Those bytes stayed `stored`
  for ever. Each upload now queues a delayed settle job that parses it anyway.
*/

const context: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000006a1",
  userId: "0191cafe-0000-7000-8000-0000000006a2",
  scopes: ["ingest:write"],
  authType: "machine",
  machineId: "0191cafe-0000-7000-8000-0000000006a3",
};

const BYTES = Buffer.from(`${JSON.stringify({ type: "user", uuid: "11111111-1111-4111-8111-111111111111", sessionId: "native", message: { role: "user", content: "hi" } })}\n`);
const SHA = createHash("sha256").update(BYTES).digest("hex");

function setup() {
  const store = new DevArchiveStore();
  const queue = new InMemoryJobQueue();
  const ingest = new IngestService(store, new MemoryObjectStorage(), queue);
  const settler = new ArtifactSettler(store, queue);
  return { store, queue, ingest, settler };
}

describe("uploads whose manifest never comes", () => {
  it("queues a delayed settle job with every upload, carrying the uploading machine", async () => {
    const { queue, ingest } = setup();
    await ingest.putRaw(context, SHA, "claude-code", "/p/s.jsonl", BYTES);

    expect(queue.jobs).toEqual([{
      id: settleJobId(context.tenantId, SHA),
      name: "settle",
      data: { tenantId: context.tenantId, userId: context.userId, machineId: context.machineId, sha256: SHA },
      delay: DEFAULT_SETTLE_DELAY_MS,
    }]);
  });

  it("parses through the ordinary parse job when the artifact is still stored", async () => {
    const { queue, ingest, settler } = setup();
    await ingest.putRaw(context, SHA, "claude-code", "/p/s.jsonl", BYTES);

    const outcome = await handlePipelineJob(queue.jobs[0]!, { pipeline: {} as never, conversions: {} as never, settler });

    expect(outcome).toEqual({ status: "queued" });
    const parse = queue.jobs.find((job) => job.name === "parse");
    expect(parse?.id, "the id the manifest uses, so the two never both run").toBe(parseJobId(context.tenantId, SHA));
    expect(parse?.data).toEqual({ tenantId: context.tenantId, userId: context.userId, machineId: context.machineId, sha256: SHA });
  });

  it("does nothing more when the manifest arrived first", async () => {
    const { queue, ingest, settler } = setup();
    await ingest.putRaw(context, SHA, "claude-code", "/p/s.jsonl", BYTES);
    await ingest.manifest(context, { machineId: context.machineId!, batchId: "b1", artifacts: [{ sha256: SHA }] });

    await settler.settle(context, SHA);

    expect(queue.jobs.filter((job) => job.name === "parse"), "one parse, whoever asked first").toHaveLength(1);
  });

  it("leaves a parsed artifact alone", async () => {
    const { store, queue, ingest, settler } = setup();
    await ingest.putRaw(context, SHA, "claude-code", "/p/s.jsonl", BYTES);
    const held = (await store.getRawArtifact(context, SHA))!;
    await store.updateRawArtifact(context, { ...held, status: "parsed" });

    expect(await settler.settle(context, SHA)).toEqual({ status: "settled" });
    expect(await settler.settle(context, "f".repeat(64))).toEqual({ status: "missing" });
    expect(queue.jobs.filter((job) => job.name === "parse")).toHaveLength(0);
    await ingest.putRaw(context, SHA, "claude-code", "/p/s.jsonl", BYTES);
    expect(queue.jobs, "a re-offer of parsed bytes queues nothing new").toHaveLength(1);
  });

  it("reads its delay from the environment, and falls back on nonsense", () => {
    expect(settleDelayMs({})).toBe(DEFAULT_SETTLE_DELAY_MS);
    expect(settleDelayMs({ MEMOAR_SETTLE_DELAY_MS: "60000" })).toBe(60_000);
    expect(settleDelayMs({ MEMOAR_SETTLE_DELAY_MS: "0" })).toBe(0);
    expect(settleDelayMs({ MEMOAR_SETTLE_DELAY_MS: "soon" })).toBe(DEFAULT_SETTLE_DELAY_MS);
    expect(settleDelayMs({ MEMOAR_SETTLE_DELAY_MS: "-5" })).toBe(DEFAULT_SETTLE_DELAY_MS);
  });
});
