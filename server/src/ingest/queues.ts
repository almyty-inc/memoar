import { Queue } from "bullmq";


export interface QueueJob<T extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  name: string;
  data: T;
}

export interface JobQueue {
  enqueue(name: string, data: Record<string, unknown>, options: { jobId: string; attempts: number }): Promise<void>;
  health(): Promise<void>;
}

export const PIPELINE_QUEUE_NAME = "memoar-pipeline";

export function redisConnectionFromUrl(redisUrl: string): { host: string; port: number; username?: string; password?: string; db?: number; tls?: Record<string, never> } {
  const url = new URL(redisUrl);
  const database = url.pathname.length > 1 ? Number.parseInt(url.pathname.slice(1), 10) : undefined;
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database !== undefined && Number.isFinite(database) ? { db: database } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export class InMemoryJobQueue implements JobQueue {
  readonly jobs: QueueJob[] = [];
  enqueue(name: string, data: Record<string, unknown>, options: { jobId: string }): Promise<void> {
    if (!this.jobs.some((job) => job.id === options.jobId)) this.jobs.push({ id: options.jobId, name, data: structuredClone(data) });
    return Promise.resolve();
  }
  health(): Promise<void> { return Promise.resolve(); }
}

export interface QueueRetention { age: number; count: number }

export interface BullMqQueuePort {
  add(name: string, data: Record<string, unknown>, options: { jobId: string; attempts: number; removeOnComplete: number; removeOnFail: QueueRetention }): Promise<unknown>;
  waitUntilReady?(): Promise<unknown>;
}

/**
 * How long a job that spent all its attempts stays in Redis.
 *
 * It cannot be forever, which is what leaving `removeOnFail` unset means. Jobs
 * here are given a deterministic id — sha256(tenant:parse:sha256) — so that an
 * agent re-offering a growing transcript queues one parse and not fifty; BullMQ
 * implements that by refusing to add a job whose key already exists, and a
 * failed job's key exists just as much as a running one's. An artifact whose
 * parse failed five times would therefore be unqueueable for the life of the
 * Redis instance: the agent would keep sending manifests, the receipt would
 * keep saying accepted, and nothing would ever run again for that transcript.
 *
 * A day is long enough to look at the failure in Bull Board and short enough
 * that the next sync retries it. Nothing is lost by the removal — the artifact
 * row carries the status and the diagnostic, and that is what `unparsed` reads.
 */
export const FAILED_JOB_RETENTION: QueueRetention = { age: 86_400, count: 1000 };

export class BullMqQueueAdapter implements JobQueue {
  constructor(private readonly queue: BullMqQueuePort) {}
  async enqueue(name: string, data: Record<string, unknown>, options: { jobId: string; attempts: number }): Promise<void> {
    await this.queue.add(name, data, { ...options, removeOnComplete: 1000, removeOnFail: FAILED_JOB_RETENTION });
  }
  async health(): Promise<void> { await this.queue.waitUntilReady?.(); }
}

export class BullMqJobQueue extends BullMqQueueAdapter {
  readonly bullQueue: Queue;
  constructor(redisUrl: string, queueName = PIPELINE_QUEUE_NAME) {
    const queue = new Queue(queueName, { connection: redisConnectionFromUrl(redisUrl) });
    super(queue);
    this.bullQueue = queue;
  }
}
