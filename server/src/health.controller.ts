import { Controller, Get, Inject } from "@nestjs/common";
import { DataSource } from "typeorm";
import { CONTRACT_VERSION } from "../libs/canonical/src/generated.js";
import { Public } from "./auth.js";
import { InMemoryJobQueue, MemoryObjectStorage, type JobQueue, type ObjectStorage } from "./ingest.js";
import { JOB_QUEUE, OBJECT_STORAGE } from "./tokens.js";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource | null,
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  @Public()
  @Get()
  async health(): Promise<Record<string, unknown>> {
    if (this.dataSource) await this.dataSource.query("SELECT 1");
    await Promise.all([this.objects.health(), this.queue.health()]);
    return {
      status: "ok",
      version: "0.1.0",
      database: this.dataSource?.isInitialized ? "postgres" : "dev-adapter",
      objectStorage: this.objects instanceof MemoryObjectStorage ? "dev-adapter" : "s3",
      queue: this.queue instanceof InMemoryJobQueue ? "dev-adapter" : "redis",
      contract: CONTRACT_VERSION,
    };
  }
}
