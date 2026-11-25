import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DataSource } from "typeorm";
import type { ArchiveStore, TenantContext } from "../archive-store.js";
import { AppModule } from "../app.module.js";
import { DefaultPipelineSeedFactory, FormatDetector, IngestPipeline, SecretScanner, type ObjectStorage } from "../ingest.js";
import { isDeletable } from "../ingest/object-storage.js";
import { ParserRegistry } from "../../libs/parsers/src/index.js";
import { embeddingProviderFromEnv } from "../search.js";
import { ARCHIVE_STORE, OBJECT_STORAGE } from "../tokens.js";
import { runCleanup, type ArtifactOrigin, type CleanupStore, type Reparse } from "./artifact-cleanup.js";
import { PostgresCleanupStore } from "./postgres-cleanup-store.js";

const USAGE = "usage: cleanup-artifacts [--apply] [--tenant <tenantId> [--user <userId> --machine <machineId>]]";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}

/** Re-parse through the same pipeline the worker runs, as the artifact's owner. */
export function pipelineReparse(store: CleanupStore, pipeline: IngestPipeline, override: ArtifactOrigin | null): Reparse {
  return async (artifact, apply) => {
    const origin = override ?? await store.origin(artifact);
    if (!origin) return "skipped: this tenant has no parsed artifact to take an owner from, pass --user and --machine";
    if (!apply) return `would reparse as user ${origin.userId} on machine ${origin.machineId}`;
    const context: TenantContext = {
      tenantId: artifact.tenantId, userId: origin.userId, machineId: origin.machineId, scopes: ["ingest:write"], authType: "machine",
    };
    return (await pipeline.process(context, artifact.sha256)).status;
  };
}

export async function runCleanupCommand(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = argValue("tenant");
  const userId = argValue("user");
  const machineId = argValue("machine");
  if ((userId || machineId) && !(tenantId && userId && machineId)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const application = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const dataSource = application.get<DataSource, DataSource | null>(DataSource, { strict: false });
    const objects = application.get<ObjectStorage>(OBJECT_STORAGE);
    if (!dataSource || !isDeletable(objects)) {
      console.error("cleanup-artifacts needs DATABASE_URL and S3 object storage. It has nothing to clean in the in-memory archive.");
      process.exitCode = 2;
      return;
    }
    const store = new PostgresCleanupStore(dataSource);
    const pipeline = new IngestPipeline(
      application.get<ArchiveStore>(ARCHIVE_STORE), objects, new ParserRegistry(), new FormatDetector(),
      new SecretScanner(), new DefaultPipelineSeedFactory(), embeddingProviderFromEnv(),
    );
    const report = await runCleanup({
      store, objects, apply,
      reparse: pipelineReparse(store, pipeline, userId && machineId ? { userId, machineId } : null),
      ...(tenantId ? { tenantIds: [tenantId] } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.errors > 0) process.exitCode = 1;
  } finally {
    await application.close();
  }
}
