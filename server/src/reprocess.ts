import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { ArchiveStore, TenantContext } from "./archive-store.js";
import { AppModule } from "./app.module.js";
import { uuidV5 } from "./ids.js";
import { DefaultPipelineSeedFactory, FormatDetector, IngestPipeline, SecretScanner, type ObjectStorage } from "./ingest.js";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { selectForReprocess } from "./reprocess-selection.js";
import { embeddingProviderFromEnv } from "./search.js";
import { ARCHIVE_STORE, OBJECT_STORAGE } from "./tokens.js";

const USAGE = [
  "usage: reprocess --tenant <tenantId> [--user <userId>] (--machine <machineId> | --no-machine)",
  "                 [--sha256 <hash>] [--status <status>] [--merged-sessions] [--stale-parser] [--dry-run]",
].join("\n");

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Parses stored artifacts again, as the operator names them.
 *
 * The machine is required, or an explicit `--no-machine`. A parse acts for the
 * machine that uploaded the bytes: the session records it, and a format with no
 * session id of its own is identified by machine and path. Run without one,
 * every session this touched was re-attributed to the placeholder machine
 * uploads get, and on dev 96 sessions say they came from it.
 */
export async function runReprocess(): Promise<void> {
  const tenantId = argValue("tenant");
  const userId = argValue("user") ?? tenantId;
  const machineId = argValue("machine");
  if (!tenantId || !userId || (!machineId && !flag("no-machine"))) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const application = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const store = application.get<ArchiveStore>(ARCHIVE_STORE);
    const objects = application.get<ObjectStorage>(OBJECT_STORAGE);
    const pipeline = new IngestPipeline(store, objects, new ParserRegistry(), new FormatDetector(), new SecretScanner(), new DefaultPipelineSeedFactory(), embeddingProviderFromEnv());
    const context: TenantContext = { tenantId, userId, scopes: ["ingest:write"], authType: "machine", ...(machineId ? { machineId } : {}) };
    const artifacts = selectForReprocess(await store.listRawArtifacts(context), {
      sha256: argValue("sha256"),
      status: argValue("status"),
      mergedSessions: flag("merged-sessions"),
      // Without a machine the run acts as an upload, so it may only touch
      // sessions already filed under the upload placeholder machine.
      staleParser: flag("stale-parser")
        ? { sessions: await store.sessionParserVersions(context), machineId: machineId ?? uuidV5(`${tenantId}:uploads`) }
        : null,
    });
    if (flag("dry-run")) {
      const selected = artifacts.map(({ sha256, status, sourcePath, capturedAt, sessionIds }) => ({ sha256, status, sourcePath, capturedAt, sessionIds }));
      // Counted per source first, because a stale-parser run on a whole
      // archive selects thousands of artifacts and the list alone says little.
      const bySource: Record<string, { artifacts: number; bytes: number }> = {};
      for (const artifact of artifacts) {
        const entry = bySource[artifact.source] ??= { artifacts: 0, bytes: 0 };
        entry.artifacts += 1;
        entry.bytes += artifact.size;
      }
      console.log(JSON.stringify({ tenantId, dryRun: true, selected: selected.length, bySource, artifacts: selected }, null, 2));
      return;
    }
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
