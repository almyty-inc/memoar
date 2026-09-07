/**
 * Fills in the numbers that can only be read at scrape time.
 *
 * Counters are incremented where the thing happens. Queue depth cannot be: the
 * queue is shared by the API and every worker, so no one process knows what is
 * in it. Keeping a local tally would drift the moment a job was retried or a
 * second worker started, and a drifting queue-depth graph is worse than none —
 * it is trusted for months before anybody notices it is wrong. So it is asked
 * of the queue when someone asks for metrics.
 */

import { Inject, Injectable } from "@nestjs/common";
import { BullMqJobQueue, type JobQueue } from "../ingest.js";
import { JOB_QUEUE } from "../tokens.js";
import { queueDepth, renderMetrics } from "./metrics.registry.js";

/** The states worth watching: work waiting, work stuck, work lost. */
const WATCHED_STATES = ["waiting", "active", "delayed", "failed"] as const;

@Injectable()
export class MetricsService {
  constructor(@Inject(JOB_QUEUE) private readonly queue: JobQueue) {}

  /** The exposition text, with the scrape-time gauges brought up to date. */
  async render(): Promise<string> {
    await this.collectQueueDepth();
    return renderMetrics();
  }

  private async collectQueueDepth(): Promise<void> {
    // Only Redis has a queue to ask. The in-memory adapter runs jobs inline, so
    // its depth is always zero and reporting zero would be a lie of a different
    // kind: it would look like a healthy queue rather than no queue at all.
    if (!(this.queue instanceof BullMqJobQueue)) return;
    try {
      const counts = await this.queue.bullQueue.getJobCounts(...WATCHED_STATES);
      for (const state of WATCHED_STATES) queueDepth.set({ state }, counts[state] ?? 0);
    } catch {
      // A scrape must not fail because Redis blinked; the rest of the metrics
      // are still worth having, and the queue's own absence shows up in the
      // health endpoint and in the job counters.
    }
  }
}
