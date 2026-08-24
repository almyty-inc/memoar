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

export interface BullMqQueuePort {
  add(name: string, data: Record<string, unknown>, options: { jobId: string; attempts: number; removeOnComplete: number }): Promise<unknown>;
  waitUntilReady?(): Promise<unknown>;
}

export class BullMqQueueAdapter implements JobQueue {
  constructor(private readonly queue: BullMqQueuePort) {}
  async enqueue(name: string, data: Record<string, unknown>, options: { jobId: string; attempts: number }): Promise<void> {
    await this.queue.add(name, data, { ...options, removeOnComplete: 1000 });
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
