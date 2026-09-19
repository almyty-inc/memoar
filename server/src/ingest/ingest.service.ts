import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { ArtifactStore, RawArtifactRecord, TenantContext } from "../archive-store.js";
import { uuidV7 } from "../ids.js";
import { artifactsIngested, ingestBytes } from "../metrics/metrics.registry.js";
import { ARCHIVE_STORE, JOB_QUEUE, OBJECT_STORAGE } from "../tokens.js";
import { type JobQueue } from "./queues.js";
import type { ObjectStorage } from "./object-storage.js";

@Injectable()
export class IngestService {
  constructor(
    @Inject(ARCHIVE_STORE) private readonly store: ArtifactStore,
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  /**
   * The ingest outcome for one artifact, without its bytes.
   *
   * The server records exactly why an artifact could not be parsed, but until
   * now nothing could read it back, so a client could only poll for a canonical
   * session that was never going to appear and give up with a timeout.
   */
  async status(context: TenantContext, sha256: string): Promise<Record<string, unknown>> {
    const artifact = await this.store.getRawArtifact(context, sha256);
    if (!artifact) throw new NotFoundException("Artifact not found");
    return {
      sha256: artifact.sha256,
      status: artifact.status,
      sessionIds: artifact.sessionIds,
      source: artifact.source,
      sourcePath: artifact.sourcePath,
      capturedAt: artifact.capturedAt,
      diagnostic: artifact.diagnostic,
    };
  }

  async putRaw(context: TenantContext, sha256: string, source: string, sourcePath: string, bytes: Uint8Array): Promise<{ created: boolean; artifact: RawArtifactRecord }> {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) throw new UnprocessableEntityException("Artifact digest does not match the path digest");
    const objectKey = `tenants/${context.tenantId}/raw/${sha256}`;
    const artifact: RawArtifactRecord = {
      id: uuidV7(), tenantId: context.tenantId, sessionIds: [], sha256, size: bytes.byteLength,
      objectKey, status: "stored", source, sourcePath, capturedAt: new Date().toISOString(), diagnostic: null,
    };
    const created = await this.store.saveRawArtifact(context, artifact);
    if (created) await this.objects.put(objectKey, bytes, "application/octet-stream");
    // Counted apart, because they mean different things: "stored" is new
    // capture arriving, "duplicate" is an agent re-offering what is already
    // held, and a machine that only ever produces duplicates is a machine whose
    // capture has quietly stopped moving.
    artifactsIngested.inc({ result: created ? "stored" : "duplicate" });
    if (created) ingestBytes.inc(bytes.byteLength);
    if (created) return { created, artifact };
    // The row that is actually held, not the one minted for this request.
    // An artifact is identified by (tenant, sha256) and the store enforces it,
    // so a re-offer of the same bytes stores nothing — but the id above was
    // freshly generated a few lines up, and returning it handed the caller a
    // uuid naming no row, different on every re-offer of one artifact. The
    // agent re-offers a growing transcript on every append, so the identity the
    // API reported for one artifact changed dozens of times.
    const stored = await this.store.getRawArtifact(context, sha256);
    return { created, artifact: stored ?? artifact };
  }

  /**
   * What this account has collected and cannot read.
   *
   * Unparseable bytes are kept on purpose — a parser written later can still
   * read them — but nothing ever said so out loud, and that silence hides the
   * one failure capture can have without failing: a pattern pointed at the
   * wrong directory. Two sources were found doing exactly that, one of them
   * collecting an editor's terminal history instead of its conversations, for
   * as long as the pattern had existed. The count is per tool, because the
   * pattern is per tool.
   */
  async unparsed(context: TenantContext): Promise<{ items: { source: string; artifacts: number; diagnostic: string | null }[] }> {
    return { items: await this.store.countUnparsedArtifactsBySource(context) };
  }

  async delta(context: TenantContext, hashes: readonly string[]): Promise<{ missing: string[] }> {
    const present = await this.store.listArtifactHashes(context, hashes);
    return { missing: hashes.filter((hash) => !present.has(hash)) };
  }

  async manifest(context: TenantContext, manifest: { machineId: string; batchId: string; artifacts: { sha256: string }[] }): Promise<Record<string, unknown>> {
    const present = await this.store.listArtifactHashes(context, manifest.artifacts.map((artifact) => artifact.sha256));
    const missing = [...new Set(manifest.artifacts.map((artifact) => artifact.sha256).filter((sha256) => !present.has(sha256)))];
    if (missing.length) {
      throw new UnprocessableEntityException({
        type: "https://memoar.dev/problems/missing-artifact-hashes",
        title: "Manifest references artifacts that were never uploaded",
        status: 422,
        code: "missing_artifact_hashes",
        missing,
      });
    }
    // Counted rather than assumed. The queue is keyed by (tenant, parse, sha),
    // so a manifest listing one artifact twice — which the agent does when two
    // watched paths resolve to the same file — only ever produced one job, and
    // the receipt still claimed two accepted and nought duplicate. A receipt
    // whose numbers are the length of the request is a receipt for the request,
    // not for the work.
    const queued = [...new Set(manifest.artifacts.map((artifact) => artifact.sha256))];
    for (const sha256 of queued) {
      const jobId = createHash("sha256").update(`${context.tenantId}:parse:${sha256}`).digest("hex");
      await this.queue.enqueue("parse", { tenantId: context.tenantId, userId: context.userId, machineId: manifest.machineId, sha256 }, { jobId, attempts: 5 });
    }
    return {
      batchId: manifest.batchId,
      accepted: queued.length,
      duplicate: manifest.artifacts.length - queued.length,
      queuedAt: new Date().toISOString(),
    };
  }
}

export { DefaultPipelineSeedFactory, fallbackNativeSessionId, IngestPipeline, IngestWorker, SCANNER_ORIGIN, type PipelineSeedFactory } from "./pipeline.js";
