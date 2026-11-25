import { createHash } from "node:crypto";
import type { ArtifactStore, TenantContext } from "../archive-store.js";
import type { JobQueue } from "./queues.js";

/** The job that makes sure an uploaded artifact is parsed even if its manifest never comes. */
export const SETTLE_JOB = "settle";

/** How long an upload may wait for its manifest before the server parses it anyway. */
export const DEFAULT_SETTLE_DELAY_MS = 15 * 60 * 1000;

/**
 * One parse per artifact, however many times it is asked for.
 *
 * BullMQ refuses a second job under an id it still holds, and refuses a custom
 * id with a colon in it, so the id is a digest of the tenant and the bytes.
 * The manifest and the settle job use this one function, which is what lets
 * the late path never parse an artifact the manifest already queued.
 */
export function parseJobId(tenantId: string, sha256: string): string {
  return createHash("sha256").update(`${tenantId}:parse:${sha256}`).digest("hex");
}

export function settleJobId(tenantId: string, sha256: string): string {
  return createHash("sha256").update(`${tenantId}:settle:${sha256}`).digest("hex");
}

export function settleDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMOAR_SETTLE_DELAY_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SETTLE_DELAY_MS;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_SETTLE_DELAY_MS;
}

/** What a queued job needs to act for the machine that uploaded the bytes. */
export function parseJobData(context: TenantContext, sha256: string, machineId?: string): Record<string, unknown> {
  const machine = machineId ?? context.machineId;
  return { tenantId: context.tenantId, userId: context.userId, ...(machine ? { machineId: machine } : {}), sha256 };
}

/**
 * Parses an artifact whose manifest never arrived.
 *
 * A parse used to be queued by the manifest and by nothing else, and the agent
 * sends the manifest only after a whole pass of up to 256 uploads. An agent
 * that stops in between leaves bytes the archive holds and will never read:
 * killed, asleep, out of disk, or out of attempts after the manifest failed
 * eight times. Each upload therefore queues this job, held back long enough
 * for the manifest to arrive first. When it runs it does nothing unless the
 * artifact is still `stored`, and then it queues the ordinary parse under the
 * ordinary id, so an artifact whose manifest job is merely waiting in a busy
 * queue is still parsed once.
 *
 * The job carries the uploading machine from the upload's own credential, so
 * a late parse identifies the session exactly as the manifest's parse would.
 */
export class ArtifactSettler {
  constructor(
    private readonly store: Pick<ArtifactStore, "getRawArtifact">,
    private readonly queue: JobQueue,
  ) {}

  async settle(context: TenantContext, sha256: string): Promise<{ status: "missing" | "settled" | "queued" }> {
    const artifact = await this.store.getRawArtifact(context, sha256);
    if (!artifact) return { status: "missing" };
    if (artifact.status !== "stored") return { status: "settled" };
    await this.queue.enqueue("parse", parseJobData(context, sha256), { jobId: parseJobId(context.tenantId, sha256), attempts: 5 });
    return { status: "queued" };
  }
}
