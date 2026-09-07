import type { TenantContext } from "./archive-store.js";
import type { ConversionService } from "./convert/conversion.service.js";
import type { IngestPipeline } from "./ingest.js";
import { jobDuration, jobsProcessed } from "./metrics/metrics.registry.js";

/** The shape both BullMQ jobs and tests hand to the dispatcher. */
export interface PipelineJob {
  name: string;
  data: Record<string, unknown>;
}

export interface PipelineHandlers {
  pipeline: IngestPipeline;
  conversions: ConversionService;
}

/** A worker acts for the tenant that queued the job, not for itself. */
export function jobContext(job: PipelineJob): TenantContext {
  const { tenantId, userId, machineId } = job.data;
  if (typeof tenantId !== "string" || typeof userId !== "string") throw new Error("invalid_tenant_job_context");
  return { tenantId, userId, scopes: ["*"], authType: "machine", ...(typeof machineId === "string" ? { machineId } : {}) };
}

/**
 * Dispatches one queued job.
 *
 * Extracted from the worker so a test can drive the same function the worker
 * calls. The alternative — a test that reaches past the dispatcher into the
 * services — proves the services work while leaving the wiring that decides
 * which service runs, and with whose tenant, covered by nothing.
 */
export async function handlePipelineJob(job: PipelineJob, handlers: PipelineHandlers): Promise<unknown> {
  // Timed and counted here, at the one point every job passes through, so a
  // job that starts failing or slowing down is visible without anyone having
  // thought to watch that particular job.
  const done = jobDuration.startTimer({ job: job.name });
  try {
    const result = await dispatch(job, handlers);
    jobsProcessed.inc({ job: job.name, result: "ok" });
    return result;
  } catch (error) {
    jobsProcessed.inc({ job: job.name, result: "failed" });
    throw error;
  } finally {
    done();
  }
}

async function dispatch(job: PipelineJob, handlers: PipelineHandlers): Promise<unknown> {
  const context = jobContext(job);
  if (job.name === "parse") {
    if (typeof job.data.sha256 !== "string") throw new Error("parse_job_missing_sha256");
    return handlers.pipeline.process(context, job.data.sha256);
  }
  if (job.name === "convert") {
    if (typeof job.data.jobId !== "string") throw new Error("convert_job_missing_job_id");
    return handlers.conversions.run(context, job.data.jobId);
  }
  throw new Error(`unsupported_pipeline_job:${job.name}`);
}
