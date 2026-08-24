import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { ArchiveStore, TenantContext } from "./archive-store.js";
import { AppModule } from "./app.module.js";
import { DefaultPipelineSeedFactory, FormatDetector, IngestPipeline, SecretScanner, type ObjectStorage } from "./ingest.js";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { embeddingProviderFromEnv } from "./search.js";
import { ARCHIVE_STORE, OBJECT_STORAGE } from "./tokens.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}

export async function runReprocess(): Promise<void> {
  const tenantId = argValue("tenant");
  const userId = argValue("user") ?? tenantId;
  if (!tenantId || !userId) {
    console.error("usage: reprocess --tenant <tenantId> [--user <userId>] [--sha256 <hash>]");
    process.exitCode = 2;
    return;
  }
  const onlySha = argValue("sha256");
  const application = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const store = application.get<ArchiveStore>(ARCHIVE_STORE);
    const objects = application.get<ObjectStorage>(OBJECT_STORAGE);
    const pipeline = new IngestPipeline(store, objects, new ParserRegistry(), new FormatDetector(), new SecretScanner(), new DefaultPipelineSeedFactory(), embeddingProviderFromEnv());
    const context: TenantContext = { tenantId, userId, scopes: ["ingest:write"], authType: "machine" };
    const artifacts = (await store.listRawArtifacts(context)).filter((artifact) => !onlySha || artifact.sha256 === onlySha);
    const results = [];
    for (const artifact of artifacts) {
      try {
        const outcome = await pipeline.process(context, artifact.sha256);
        results.push({ sha256: artifact.sha256, ...outcome });
      } catch (error) {
        results.push({ sha256: artifact.sha256, status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
    console.log(JSON.stringify({ tenantId, reprocessed: results.length, results }, null, 2));
  } finally {
    await application.close();
  }
}
