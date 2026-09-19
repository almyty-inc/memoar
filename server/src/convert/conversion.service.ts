import { Body, Controller, Get, HttpCode, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { Redirect } from "@nestjs/common";
import type { ArchivedSession, JobRecord, JobStore, MachineStore, SessionStore, TenantContext } from "../archive-store.js";
import { Tenant } from "../auth.js";
import { InMemoryJobQueue, type JobQueue, type ObjectStorage } from "../ingest.js";
import { uuidV7 } from "../ids.js";
import { PackService } from "../search.js";
import { ARCHIVE_STORE, JOB_QUEUE, OBJECT_STORAGE } from "../tokens.js";
import { ConversionEngine } from "./engine.js";
import { MaterializeDto, RequestConversionDto } from "../convert.dto.js";
import { serializeBundle } from "./serialize.js";

/** Pre-signed bundle URLs stay valid long enough for an offline agent to reconnect. */
const MATERIALIZE_URL_TTL_SECONDS = 3600;

@Injectable()
export class ConversionService {
  private readonly engine = new ConversionEngine();

  constructor(
    @Inject(ARCHIVE_STORE) private readonly store: SessionStore & JobStore & MachineStore,
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
    @Inject(PackService) private readonly packs: PackService,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  /**
   * Cited, token-budgeted evidence for open-target injection preludes. Built
   * from the archive around the session's title/workspace; failures degrade to
   * a transcript-only prelude rather than failing the conversion.
   */
  private async archiveEvidenceFor(context: TenantContext, session: ArchivedSession): Promise<string | undefined> {
    try {
      const pack = await this.packs.build(context, {
        query: `${session.title} ${session.workspace.path}`.trim(),
        maxTokens: 2000,
        maxEvidence: 6,
        maxSessions: 4,
        maxExcerptChars: 1200,
        freshnessPolicy: "mixed",
      });
      const markdown = typeof pack.markdown === "string" ? pack.markdown : "";
      const evidence = Array.isArray(pack.evidence) ? pack.evidence.length : 0;
      return evidence > 0 ? markdown : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Accepts a conversion and hands the work to the worker.
   *
   * Converting is processor work — rendering every turn, hashing and base64ing
   * the files, serialising the bundle — and all of it is synchronous on one
   * thread. Run inside the request, twenty at once took 1256ms and starved
   * /health to 403ms, which is long enough for an orchestrator to call a busy
   * container a dead one.
   *
   * The contract has said `queued` since the beginning; only the implementation
   * disagreed.
   */
  async request(context: TenantContext, input: { sessionId: string; target: string; fallback: "fail" | "injection" }): Promise<Record<string, unknown>> {
    // Existence, not the session: accepting the work must not cost a hydration
    // of every turn and block the conversion is about to re-read anyway.
    if (!await this.store.sessionExists(context, input.sessionId)) throw new NotFoundException("Session not found");
    const id = uuidV7();
    const createdAt = new Date().toISOString();
    const job: JobRecord = {
      id, tenantId: context.tenantId, kind: "convert", status: "queued", payload: input,
      result: null, error: null, createdAt, updatedAt: createdAt,
    };
    await this.store.saveJob(context, job);
    await this.queue.enqueue("convert", { tenantId: context.tenantId, userId: context.userId, jobId: id }, { jobId: `convert-${id}`, attempts: 3 });
    // Without a distributed queue there is no worker to pick the job up, which
    // is development and tests. Running it here keeps that deployment working;
    // the code that runs is the same code the worker calls.
    if (this.queue instanceof InMemoryJobQueue) return this.run(context, id);
    return { id, sessionId: input.sessionId, target: input.target, status: "queued", createdAt };
  }

  /** Performs a queued conversion. Called by the worker, and inline in development. */
  async run(context: TenantContext, jobId: string): Promise<Record<string, unknown>> {
    const job = await this.store.getJob(context, jobId);
    if (!job || job.kind !== "convert") throw new NotFoundException("Conversion not found");
    const input = job.payload as { sessionId: string; target: string; fallback: "fail" | "injection" };
    const session = await this.store.getSession(context, input.sessionId);
    if (!session) throw new NotFoundException("Session not found");
    const { id, createdAt } = job;
    await this.store.saveJob(context, { ...job, status: "running", updatedAt: new Date().toISOString() });
    try {
      const archiveEvidence = !this.engine.supportsNatively(input.target) && input.fallback === "injection"
        ? await this.archiveEvidenceFor(context, session)
        : undefined;
      const bundle = this.engine.convert(session, input.target, input.fallback, archiveEvidence);
      const objectKey = `tenants/${context.tenantId}/conversions/${id}.json`;
      await this.objects.put(objectKey, serializeBundle(bundle), "application/json");
      const result = { objectKey, resumeCommand: bundle.resumeCommand, report: bundle.report, fileCount: bundle.files.length };
      await this.store.saveJob(context, { ...job, status: "ready", result, updatedAt: new Date().toISOString() });
      return { id, sessionId: input.sessionId, target: input.target, status: "ready", createdAt, resumeCommand: bundle.resumeCommand, report: bundle.report };
    } catch (error) {
      const message = error instanceof Error ? error.message : "conversion_failed";
      await this.store.saveJob(context, { ...job, status: "failed", error: message, updatedAt: new Date().toISOString() });
      return { id, sessionId: input.sessionId, target: input.target, status: "failed", createdAt, report: { error: message } };
    }
  }

  async get(context: TenantContext, jobId: string): Promise<Record<string, unknown>> {
    const job = await this.store.getJob(context, jobId);
    if (!job || job.kind !== "convert") throw new NotFoundException("Conversion not found");
    return { id: job.id, sessionId: job.payload.sessionId, target: job.payload.target, status: job.status, createdAt: job.createdAt, ...(job.result ?? {}), ...(job.error ? { report: { error: job.error } } : {}) };
  }

  async download(context: TenantContext, jobId: string): Promise<{ url: string }> {
    const job = await this.store.getJob(context, jobId);
    const objectKey = job?.result?.objectKey;
    if (job?.status !== "ready" || typeof objectKey !== "string") throw new NotFoundException("Conversion is not ready");
    return { url: await this.objects.signedDownloadUrl(objectKey, 300) };
  }

  /**
   * Queues the bundle for one machine to write to disk.
   *
   * The machine is resolved first. A command addressed to a machine that does
   * not exist is never polled for, so it is never delivered and never acked: it
   * sits `pending` for ever with no dead-letter, and the caller is told 202. The
   * lookup is tenant-scoped, so another account's machine is as invalid as a
   * missing one and the refusal does not distinguish them — whether a uuid names
   * somebody else's machine is not something this caller gets to learn.
   */
  async materialize(context: TenantContext, jobId: string, machineId: string): Promise<void> {
    const job = await this.store.getJob(context, jobId);
    if (job?.status !== "ready") throw new NotFoundException("Conversion is not ready");
    if (!await this.store.getMachine(context, machineId)) {
      throw new NotFoundException("No machine of this account with that id");
    }
    // The command carries a pre-signed URL so the agent needs no archive
    // scope: machine credentials stay restricted to ingest and their own
    // command channel.
    const objectKey = job.result?.objectKey;
    const downloadUrl = typeof objectKey === "string"
      ? await this.objects.signedDownloadUrl(objectKey, MATERIALIZE_URL_TTL_SECONDS)
      : null;
    await this.store.createMachineCommand(context, {
      machineId,
      kind: "materialize",
      payload: {
        jobId,
        sessionId: job.payload.sessionId,
        target: job.payload.target,
        objectKey,
        downloadUrl,
        resumeCommand: job.result?.resumeCommand,
      },
    });
  }
}

@Controller("convert")
export class ConvertController {
  constructor(private readonly conversions: ConversionService) {}

  @Post()
  @HttpCode(202)
  request(@Tenant() context: TenantContext, @Body() body: RequestConversionDto) {
    return this.conversions.request(context, body);
  }

  @Get(":jobId")
  get(@Tenant() context: TenantContext, @Param("jobId", ParseUUIDPipe) jobId: string) { return this.conversions.get(context, jobId); }

  @Get(":jobId/download")
  @Redirect(undefined, 302)
  download(@Tenant() context: TenantContext, @Param("jobId", ParseUUIDPipe) jobId: string) { return this.conversions.download(context, jobId); }

  @Post(":jobId/materialize")
  @HttpCode(202)
  async materialize(@Tenant() context: TenantContext, @Param("jobId", ParseUUIDPipe) jobId: string, @Body() body: MaterializeDto): Promise<{ queued: true }> {
    await this.conversions.materialize(context, jobId, body.machineId);
    return { queued: true };
  }
}
