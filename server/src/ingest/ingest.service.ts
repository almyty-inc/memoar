import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Injectable, NotFoundException, Param, Post, Put, Res, UnprocessableEntityException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Response } from "express";
import type { AnnotationKind } from "../../libs/canonical/src/generated.js";
import { ParserRegistry, type SessionSeed } from "../../libs/parsers/src/index.js";
import type { EmbeddingProvider } from "../search.js";
import type { AnnotationStore, ArtifactStore, RawArtifactRecord, SessionStore, TenantContext } from "../archive-store.js";
import { Tenant } from "../auth.js";
import { uuidV5, uuidV7 } from "../ids.js";
import { artifactsIngested, ingestBytes, sessionsArchived } from "../metrics/metrics.registry.js";
import { ARCHIVE_STORE, JOB_QUEUE, OBJECT_STORAGE } from "../tokens.js";
import { type JobQueue, type QueueJob } from "./queues.js";
import type { ObjectStorage } from "./object-storage.js";
import { FormatDetector, SecretScanner } from "./detection.js";
import { DeltaDto, ManifestDto } from "./ingest.dto.js";

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
    return { created, artifact };
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
    let accepted = 0;
    for (const artifact of manifest.artifacts) {
      const jobId = createHash("sha256").update(`${context.tenantId}:parse:${artifact.sha256}`).digest("hex");
      await this.queue.enqueue("parse", { tenantId: context.tenantId, userId: context.userId, machineId: manifest.machineId, sha256: artifact.sha256 }, { jobId, attempts: 5 });
      accepted += 1;
    }
    return { batchId: manifest.batchId, accepted, duplicate: 0, queuedAt: new Date().toISOString() };
  }
}

export interface PipelineSeedFactory {
  create(context: TenantContext, artifact: RawArtifactRecord, format: { source: string; version: string }): SessionSeed;
}

/**
 * Identifies a capture when the transcript itself carries no session id.
 *
 * The agent watches a session file and uploads it again whenever it changes, so
 * a conversation arrives many times as it grows. Identity therefore cannot be
 * the hash of the file, which changes on every append — each capture would look
 * like a new session, and for formats whose turns carry their own ids the save
 * would fail outright.
 *
 * Where the file sits is the stable fact. Antigravity, for one, keeps the
 * conversation id in the directory name and nowhere in the file. The machine is
 * part of the key so the same path on two machines stays two conversations.
 *
 * An upload has no machine and its name is whatever the user's file was called,
 * so it keeps the hash: merging two unrelated files that happen to share a name
 * is worse than storing an edited export twice.
 */
export function fallbackNativeSessionId(context: TenantContext, artifact: RawArtifactRecord): string {
  return context.machineId && artifact.sourcePath
    ? `path:${context.machineId}:${artifact.sourcePath}`
    : `sha:${artifact.sha256.slice(0, 16)}`;
}

export class DefaultPipelineSeedFactory implements PipelineSeedFactory {
  create(context: TenantContext, artifact: RawArtifactRecord, format: { source: string; version: string }): SessionSeed {
    const now = artifact.capturedAt;
    const native = fallbackNativeSessionId(context, artifact);
    // Derived from the identity rather than minted, so a parser that numbers its
    // turns from the seed gives the same turn the same id on every capture.
    const sessionId = uuidV5(`${context.tenantId}:${format.source}:${format.version}:${native}`);
    return {
      id: sessionId,
      // An upload was captured by nobody, and the contract requires a machine.
      // One derived id per tenant at least keeps every import pointing at the
      // same origin instead of inventing a machine per file.
      source: { vendor: format.source, tool: format.source, version: format.version, machineId: context.machineId ?? uuidV5(`${context.tenantId}:uploads`), nativeSessionId: native },
      workspace: { path: artifact.sourcePath ?? "/memoar/imports" },
      createdAt: now,
      updatedAt: now,
      title: `${format.source} imported session`,
      models: [],
      tokenTotals: { input: 0, output: 0 },
      provenance: [{ kind: "native", sourceId: artifact.sha256, capturedAt: now, parserVersion: "0.1.0" }],
      visibility: { scope: "private", ownerId: context.userId },
      ext: { rawArtifactId: artifact.id },
    };
  }
}

export class IngestPipeline {
  constructor(
    private readonly store: ArtifactStore & SessionStore & AnnotationStore,
    private readonly objects: ObjectStorage,
    private readonly parsers = new ParserRegistry(),
    private readonly detector = new FormatDetector(),
    private readonly scanner = new SecretScanner(),
    private readonly seeds: PipelineSeedFactory = new DefaultPipelineSeedFactory(),
    private readonly embeddings: EmbeddingProvider | null = null,
  ) {}

  async process(context: TenantContext, sha256: string): Promise<{ status: string; sessionIds: string[] }> {
    const artifact = await this.store.getRawArtifact(context, sha256);
    if (!artifact) throw new Error("artifact_not_found");
    const bytes = await this.objects.get(artifact.objectKey);
    const format = this.detector.detect(artifact.source, bytes);
    const result = this.parsers.parse({ source: format.source, version: format.version, raw: bytes, seed: this.seeds.create(context, artifact, format) });
    if (result.kind === "unknown") {
      await this.store.updateRawArtifact(context, { ...artifact, status: "unknown_format", diagnostic: result.diagnostic });
      return { status: "unknown_format", sessionIds: [] };
    }
    const findings = this.scanner.scan(bytes);
    const savedSessionIds: string[] = [];
    try {
    for (const [index, parsedSession] of result.sessions.entries()) {
      const canonicalSessionId = await this.store.resolveSessionIdentity(context, {
        sourceTool: parsedSession.source.tool,
        sourceVersion: parsedSession.source.version,
        nativeSessionId: parsedSession.source.nativeSessionId ?? `${fallbackNativeSessionId(context, artifact)}:${index}`,
      }, artifact.sessionIds[index] ?? parsedSession.id);
      const session = { ...parsedSession, id: canonicalSessionId, redactionStatus: findings.length ? "findings" as const : "clear" as const };
      await this.store.saveSession(context, session);
      // Every finding at once. Written one by one, a transcript that leaked a
      // credential on a hundred lines cost a hundred round trips to store.
      await this.store.replaceAnnotations(
        context,
        session.id,
        "redaction_mask" satisfies AnnotationKind,
        findings.map((finding) => ({ kind: finding.kind, start: finding.start, end: finding.end, preview: finding.preview })),
      );
      if (this.embeddings) {
        try {
          const document = [session.title, session.summary ?? "", ...session.turns.flatMap((turn) => turn.blocks.map((block) => block.text ?? ""))].join("\n");
          await this.store.saveSessionEmbedding(context, session.id, await this.embeddings.embed(document.slice(0, 20000)));
        } catch {
          // Embedding persistence is best-effort. Lexical search stays authoritative when the provider fails.
        }
      }
      savedSessionIds.push(session.id);
      // Labelled by tool, not by tenant: "how much is Codex capture producing"
      // is a question about the product, and one series per customer is how a
      // metrics store is brought down by the service it watches.
      sessionsArchived.inc({ source: session.source.tool });
    }
    } catch (error) {
      const diagnostic = `session persistence failed: ${error instanceof Error ? error.message : String(error)}`;
      await this.store.updateRawArtifact(context, { ...artifact, sessionIds: savedSessionIds, status: "failed", diagnostic });
      return { status: "failed", sessionIds: savedSessionIds };
    }
    await this.store.updateRawArtifact(context, { ...artifact, sessionIds: savedSessionIds, status: "parsed", diagnostic: null });
    return { status: "parsed", sessionIds: savedSessionIds };
  }
}

export class IngestWorker {
  constructor(private readonly pipeline: IngestPipeline) {}
  async handle(job: QueueJob<{ tenantId: string; userId: string; machineId?: string; sha256: string }>): Promise<Record<string, unknown>> {
    const context: TenantContext = {
      tenantId: job.data.tenantId, userId: job.data.userId, scopes: ["ingest:write"], authType: "machine",
      ...(job.data.machineId ? { machineId: job.data.machineId } : {}),
    };
    return this.pipeline.process(context, job.data.sha256);
  }
}

const SHA256 = /^[a-f0-9]{64}$/;

@Controller("ingest")
export class IngestController {
  constructor(@Inject(IngestService) private readonly ingest: IngestService) {}

  @Put("artifacts/:sha256")
  async put(
    @Tenant() context: TenantContext,
    @Param("sha256") sha256: string,
    @Headers("x-memoar-source") source: string,
    @Headers("x-memoar-source-path") sourcePath: string,
    @Body() body: Buffer,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    if (!Buffer.isBuffer(body)) throw new BadRequestException("application/octet-stream body is required");
    const result = await this.ingest.putRaw(context, sha256, source, sourcePath, body);
    response.status(result.created ? 201 : 208);
    return { id: result.artifact.id, status: result.created ? "stored" : "duplicate" };
  }

  @Get("artifacts/:sha256/status")
  status(@Tenant() context: TenantContext, @Param("sha256") sha256: string): Promise<Record<string, unknown>> {
    // The contract pins the digest shape; anything else is a malformed request
    // rather than a lookup that happens to miss.
    if (!SHA256.test(sha256)) throw new BadRequestException("sha256 must be a 64 character lowercase hex digest");
    return this.ingest.status(context, sha256);
  }

  @Post("manifests")
  @HttpCode(202)
  manifest(@Tenant() context: TenantContext, @Body() body: ManifestDto) {
    return this.ingest.manifest(context, body);
  }

  @Post("delta")
  delta(@Tenant() context: TenantContext, @Body() body: DeltaDto) { return this.ingest.delta(context, body.hashes); }
}
