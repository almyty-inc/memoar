import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Worker, type Job } from "bullmq";
import type { ArchiveStore } from "./archive-store.js";
import { AppModule } from "./app.module.js";
import { DefaultPipelineSeedFactory, FormatDetector, IngestPipeline, PIPELINE_QUEUE_NAME, redisConnectionFromUrl, SecretScanner, type ObjectStorage } from "./ingest.js";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { embeddingProviderFromEnv } from "./search.js";
import { ConversionService } from "./convert/conversion.service.js";
import { errorAggregator, persistErrors } from "./errors/error-aggregator.js";
import { startMetricsListener } from "./metrics/metrics-listener.js";
import { MetricsService } from "./metrics/metrics.service.js";
import { handlePipelineJob } from "./pipeline-jobs.js";
import { runRetentionSweep } from "./settings.js";
import { assertProductionCredentials } from "./startup-checks.js";
import { ARCHIVE_STORE, OBJECT_STORAGE } from "./tokens.js";

export async function runWorker(): Promise<void> {
  assertProductionCredentials();
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for the worker");
  const context = await NestFactory.createApplicationContext(AppModule);
  const store = context.get<ArchiveStore>(ARCHIVE_STORE);
  const objects = context.get<ObjectStorage>(OBJECT_STORAGE);
  const pipeline = new IngestPipeline(store, objects, new ParserRegistry(), new FormatDetector(), new SecretScanner(), new DefaultPipelineSeedFactory(), embeddingProviderFromEnv());
  const conversions = context.get(ConversionService);
  // Conversion is processor work and belongs here rather than in a request:
  // done inline it did not overlap with anything, and starved the API's own
  // health endpoint while it ran.
  const worker = new Worker<Record<string, unknown>, unknown, string>(
    PIPELINE_QUEUE_NAME,
    (job: Job<Record<string, unknown>, unknown, string>) => handlePipelineJob(job, { pipeline, conversions }),
    {
      connection: redisConnectionFromUrl(redisUrl),
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
    },
  );
  await worker.waitUntilReady();

  // The worker does the slow half of the product and said nothing about itself
  // until now. Queue depth is read here too: this process is the one that knows
  // whether the queue is draining.
  // The worker's failures are the ones that mean a transcript was never
  // archived, and they are the most likely reason somebody restarts it.
  const stopPersistingErrors = persistErrors(errorAggregator);
  const metrics = context.get(MetricsService);
  const metricsServer = startMetricsListener({
    token: process.env.MEMOAR_METRICS_TOKEN,
    port: Number(process.env.MEMOAR_WORKER_METRICS_PORT ?? 9464),
    ...(process.env.MEMOAR_METRICS_HOST ? { host: process.env.MEMOAR_METRICS_HOST } : {}),
    render: () => metrics.render(),
  });

  const sweep = async (): Promise<void> => {
    try {
      const result = await runRetentionSweep(store);
      if (result.sweptTenants > 0) {
        console.log(`[retention] swept ${result.sweptTenants} tenants: ${result.deletedSessions} sessions, ${result.deletedArtifacts} artifacts deleted`);
      }
      // An account whose deletion policy did not run is the one thing here
      // worth waking somebody for, and it is now the only thing that does not
      // stop the rest of the sweep — so it has to be said out loud per account.
      for (const failure of result.failedTenants) {
        console.error(`[retention] tenant ${failure.tenantId} was not swept: ${failure.error}`);
      }
    } catch (error) {
      console.error("[retention] sweep failed", error);
    }
  };
  await sweep();
  const sweepTimer = setInterval(() => { void sweep(); }, Number(process.env.RETENTION_SWEEP_INTERVAL_MS ?? 3_600_000));

  const shutdown = async (): Promise<void> => {
    clearInterval(sweepTimer);
    stopPersistingErrors();
    metricsServer?.close();
    await worker.close();
    await context.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}