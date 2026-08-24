import { JobEntity } from "../../entities.js";
import type { TenantContext } from "../context.js";
import type { JobStore } from "../interfaces.js";
import type { JobRecord } from "../records.js";
import { TenantRunner } from "./runner.js";

export class PostgresJobStore implements JobStore {
  constructor(private readonly runner: TenantRunner) {}

  async saveJob(context: TenantContext, job: JobRecord): Promise<void> {
    await this.runner.inTenant(context, async (manager) => { await manager.getRepository(JobEntity).save({
      ...job, createdAt: new Date(job.createdAt), updatedAt: new Date(job.updatedAt),
    }); });
  }

  async getJob(context: TenantContext, jobId: string): Promise<JobRecord | null> {
    return this.runner.inTenant(context, async (manager) => {
      const row = await manager.getRepository(JobEntity).findOneBy({ id: jobId, tenantId: context.tenantId });
      return row ? { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } : null;
    });
  }
}
