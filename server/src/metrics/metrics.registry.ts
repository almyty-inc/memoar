/**
 * What this service says about itself while it is running.
 *
 * There was a health endpoint, which answers one question — is it up — and a
 * request log, which answers questions you already know to ask. Neither tells
 * you that the p99 has been climbing all week, that a queue has been draining
 * slower than it fills since Tuesday, or that one route started returning 500s
 * an hour ago. That is what this is for.
 *
 * Two rules hold everywhere below.
 *
 * No tenant labels. A metric labelled by tenant grows a new time series per
 * customer, which is how monitoring falls over; it also puts who-uses-what into
 * a system that is scraped, stored and shared more freely than the archive is.
 * Per-tenant questions belong to the archive, which has row-level security.
 *
 * Route patterns, never paths. `/v1/sessions/:id` is one series; the concrete
 * path is one series per session and an unbounded label.
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

// Heap, resident memory, event-loop lag, GC pauses, open handles. The event
// loop lag is the one that matters most here: this process does JSON parsing
// and hashing on request threads, and a lag that grows means every route is
// slow at once for a reason no single route explains.
collectDefaultMetrics({ register: registry, prefix: "memoar_" });

export const httpRequests = new Counter({
  name: "memoar_http_requests_total",
  help: "HTTP requests by method, route pattern and status code.",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: "memoar_http_request_duration_seconds",
  help: "How long requests take, by method and route pattern.",
  labelNames: ["method", "route"] as const,
  // Down to 5ms because most reads should be there, and up to 10s because
  // ingest and export are not: a bucket set that stops at 1s cannot tell a
  // 2-second export from a 2-minute hang.
  buckets: [0.005, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Errors, by class only.
 *
 * Not by fingerprint: that label is derived from a message, and a message is
 * attacker-influenced often enough that it would be an unbounded label set on
 * the one path where things are already going wrong. The fingerprints live in
 * the aggregator, which is bounded and is not a time series.
 */
export const errorsRecorded = new Counter({
  name: "memoar_errors_total",
  help: "Unhandled failures, by error class.",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const authFailures = new Counter({
  name: "memoar_auth_failures_total",
  help: "Rejected credentials, by why they were rejected.",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const rateLimitRejections = new Counter({
  name: "memoar_rate_limit_rejections_total",
  help: "Requests refused by a rate limit, by which limit refused them.",
  labelNames: ["limit"] as const,
  registers: [registry],
});

export const artifactsIngested = new Counter({
  name: "memoar_ingest_artifacts_total",
  help: "Raw artifacts received, by outcome.",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const ingestBytes = new Counter({
  name: "memoar_ingest_bytes_total",
  help: "Bytes of raw transcript accepted into the object store.",
  registers: [registry],
});

export const sessionsArchived = new Counter({
  name: "memoar_sessions_archived_total",
  help: "Sessions written to the archive, by the tool they came from.",
  labelNames: ["source"] as const,
  registers: [registry],
});

export const jobsProcessed = new Counter({
  name: "memoar_jobs_total",
  help: "Background jobs run, by kind and outcome.",
  labelNames: ["job", "result"] as const,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: "memoar_job_duration_seconds",
  help: "How long background jobs take, by kind.",
  labelNames: ["job"] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 60, 300],
  registers: [registry],
});

/**
 * How much work is waiting.
 *
 * A gauge rather than a counter, and read at scrape time rather than kept in
 * step by hand: the queue is shared by every process, so the only honest
 * source is the queue itself. See `MetricsService`.
 */
export const queueDepth = new Gauge({
  name: "memoar_queue_depth",
  help: "Jobs in the queue, by state.",
  labelNames: ["state"] as const,
  registers: [registry],
});

/** The exposition text a scrape returns. */
export function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const METRICS_CONTENT_TYPE = registry.contentType;
