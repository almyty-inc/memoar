// Turning stored bytes into canonical sessions.
// Split out of ingest.service.ts, which was over the file-size rule.

import type { AnnotationKind } from "../../libs/canonical/src/generated.js";
import { ParserRegistry, type SessionSeed } from "../../libs/parsers/src/index.js";
import type { EmbeddingProvider } from "../search.js";
import type { AnnotationStore, ArchivedSession, ArtifactStore, RawArtifactRecord, SessionStore, SettingsStore, TeamOptinStore, TenantContext } from "../archive-store.js";
import { redactionPatterns } from "../redaction.js";
import { uuidV5 } from "../ids.js";
import { sessionsArchived } from "../metrics/metrics.registry.js";
import type { QueueJob } from "./queues.js";
import type { ObjectStorage } from "./object-storage.js";
import { FormatDetector, SecretScanner } from "./detection.js";
import { IngestTeamStamp } from "./team-stamp.js";

/** Names the rows the secret scanner owns, so re-scanning replaces only its own. */
export const SCANNER_ORIGIN = "secret-scanner";

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
      // Replaced with the parser that actually ran, once one has been chosen.
      provenance: [{ kind: "native", sourceId: artifact.sha256, capturedAt: now, parserVersion: "pending" }],
      visibility: { scope: "private", ownerId: context.userId },
      ext: { rawArtifactId: artifact.id },
    };
  }
}

export class IngestPipeline {
  constructor(
    private readonly store: ArtifactStore & SessionStore & AnnotationStore & SettingsStore & TeamOptinStore,
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
    const savedSessionIds: string[] = [];
    try {
      return await this.parse(context, artifact, savedSessionIds);
    } catch (error) {
      /*
        Every way a parse can fail ends here, in the row somebody reads, and
        then goes on to the queue.

        Only the session loop used to be guarded, and only so its failure could
        be swallowed: `process` returned `{ status: "failed" }`, so BullMQ saw a
        job that had completed and never spent the five attempts configured for
        it. Two workers saving the same conversation deadlock in Postgres, which
        is the most ordinary transient failure this pipeline has — 32 artifacts
        in the dev archive are permanently `failed` with `deadlock detected` for
        exactly that reason, and a retry would have parsed every one of them.

        Everything before the loop — fetching the bytes, detecting the format,
        the parser itself — threw straight past, leaving the artifact on
        `stored` with no diagnostic. That is also precisely what an artifact
        nobody has queued yet looks like, and `countUnparsedArtifactsBySource`
        counts neither, so the failure reached nobody at all.
      */
      await this.recordFailure(context, artifact, savedSessionIds, error);
      throw error;
    }
  }

  /** Says why, without hiding the original failure if saying so fails too. */
  private async recordFailure(context: TenantContext, artifact: RawArtifactRecord, sessionIds: string[], error: unknown): Promise<void> {
    const diagnostic = `parse failed: ${error instanceof Error ? error.message : String(error)}`;
    try {
      await this.store.updateRawArtifact(context, { ...artifact, sessionIds, status: "failed", diagnostic });
    } catch {
      // The failure being reported is worth more than the failure to report it.
    }
  }

  private async parse(context: TenantContext, artifact: RawArtifactRecord, savedSessionIds: string[]): Promise<{ status: string; sessionIds: string[] }> {
    const bytes = await this.objects.get(artifact.objectKey);
    const format = this.detector.detect(artifact.source, bytes);
    const result = this.parsers.parse({ source: format.source, version: format.version, raw: bytes, seed: this.seeds.create(context, artifact, format) });
    if (result.kind === "unknown") {
      await this.store.updateRawArtifact(context, { ...artifact, status: "unknown_format", diagnostic: result.diagnostic });
      return { status: "unknown_format", sessionIds: [] };
    }
    // The tenant's own patterns, not the four built-in ones: emailScan and the
    // custom patterns were settings nothing ever read.
    const settings = await this.store.getTenantSettings(context);
    const findings = this.scanner.scan(bytes, redactionPatterns(settings.redaction));
    // Standing team consent, resolved once per artifact and applied per session.
    const teamStamp = new IngestTeamStamp(this.store, context);
    for (const [index, parsedSession] of result.sessions.entries()) {
      const canonicalSessionId = await this.store.resolveSessionIdentity(context, {
        sourceTool: parsedSession.source.tool,
        sourceVersion: parsedSession.source.version,
        nativeSessionId: parsedSession.source.nativeSessionId ?? `${fallbackNativeSessionId(context, artifact)}:${index}`,
      }, artifact.sessionIds[index] ?? parsedSession.id);
      /*
        The parser that actually ran, by name and version.

        The seed stamps a placeholder because the parser is not known until the
        format is detected and dispatched; leaving it there recorded every
        session in the archive as `0.1.0` whatever had parsed it — the Claude
        Code parser calls itself `claude-code:v1:0.2.0`. Reprocessing exists to
        replay a parser improvement over what earlier versions produced, and it
        cannot find those sessions if provenance says they were all the same.
      */
      const parsed: ArchivedSession = {
        ...parsedSession,
        id: canonicalSessionId,
        provenance: parsedSession.provenance.map((entry) => (
          entry.kind === "native" ? { ...entry, parserVersion: result.parser } : entry
        )),
        redactionStatus: findings.length ? "findings" as const : "clear" as const,
      };
      // Widened here or never: the opt-in is written into the row rather than
      // consulted by every reader. See IngestTeamStamp for the two gates.
      const session: ArchivedSession = { ...parsed, visibility: await teamStamp.visibilityFor(parsed) };
      await this.store.saveSession(context, session);
      // Every finding at once. Written one by one, a transcript that leaked a
      // credential on a hundred lines cost a hundred round trips to store.
      /*
        Scanner findings only.

        This used to replace every redaction_mask on the session, so an agent
        re-uploading a transcript as it grew deleted the masks the user had
        placed by hand — the archive quietly undoing somebody's redaction review
        every few minutes. Naming the producer confines the delete to the rows
        this scan owns.

        `basis: "artifact"` because these offsets are byte offsets into the
        upload. They address nothing that is ever served, so the projection
        ignores them for range-masking and removes these secrets by pattern
        instead; what they are for is the findings count and the review UI.
      */
      await this.store.replaceAnnotations(
        context,
        session.id,
        "redaction_mask" satisfies AnnotationKind,
        findings.map((finding) => ({
          kind: finding.kind, start: finding.start, end: finding.end, preview: finding.preview, basis: "artifact",
        })),
        SCANNER_ORIGIN,
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
