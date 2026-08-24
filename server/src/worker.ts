import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Worker, type Job } from "bullmq";
import type { ArchiveStore, TenantContext } from "./archive-store.js";
import { AppModule } from "./app.module.js";
import { DefaultPipelineSeedFactory, FormatDetector, IngestPipeline, PIPELINE_QUEUE_NAME, redisConnectionFromUrl, SecretScanner, type ObjectStorage } from "./ingest.js";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { embeddingProviderFromEnv } from "./search.js";
import { runRetentionSweep } from "./settings.js";
import { ARCHIVE_STORE, OBJECT_STORAGE } from "./tokens.js";

function jobContext(job: Job<Record<string, unknown>, unknown, string>): TenantContext {
  const tenantId = job.data.tenantId;
  const userId = job.data.userId;
  if (typeof tenantId !== "string" || typeof userId !== "string") throw new Error("invalid_tenant_job_context");
  return { tenantId, userId, scopes: ["*"], authType: "machine", ...(typeof job.data.machineId === "string" ? { machineId: job.data.machineId } : {}) };
}

export async function runWorker(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for the worker");
  const context = await NestFactory.createApplicationContext(AppModule);
  const store = context.get<ArchiveStore>(ARCHIVE_STORE);
  const objects = context.get<ObjectStorage>(OBJECT_STORAGE);
  const pipeline = new IngestPipeline(store, objects, new ParserRegistry(), new FormatDetector(), new SecretScanner(), new DefaultPipelineSeedFactory(), embeddingProviderFromEnv());
  const worker = new Worker<Record<string, unknown>, unknown, string>(PIPELINE_QUEUE_NAME, async (job) => {
    if (job.name === "parse") {
      if (typeof job.data.sha256 !== "string") throw new Error("parse_job_missing_sha256");
      return pipeline.process(jobContext(job), job.data.sha256);
    }
    throw new Error(`unsupported_pipeline_job:${job.name}`);
  }, {
    connection: redisConnectionFromUrl(redisUrl),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  });
  await worker.waitUntilReady();

  const sweep = async (): Promise<void> => {
    try {
      const result = await runRetentionSweep(store);
      if (result.sweptTenants > 0) {
        console.log(`[retention] swept ${result.sweptTenants} tenants: ${result.deletedSessions} sessions, ${result.deletedArtifacts} artifacts deleted`);
      }
    } catch (error) {
      console.error("[retention] sweep failed", error);
    }
  };
  await sweep();
  const sweepTimer = setInterval(() => { void sweep(); }, Number(process.env.RETENTION_SWEEP_INTERVAL_MS ?? 3_600_000));

  const shutdown = async (): Promise<void> => {
    clearInterval(sweepTimer);
    await worker.close();
    await context.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}