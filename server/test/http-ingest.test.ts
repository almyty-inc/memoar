import { createHash } from "node:crypto";
import { Server } from "node:http";
import { type CanActivate, type ExecutionContext, type INestApplication, Injectable, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { InMemoryJobQueue, IngestController, IngestService, MemoryObjectStorage, type ObjectStorage } from "../src/ingest.js";
import { configureApp } from "../src/main.js";
import { ARCHIVE_STORE, JOB_QUEUE, OBJECT_STORAGE } from "../src/tokens.js";

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ tenantContext?: Record<string, unknown> }>().tenantContext = {
      tenantId: "0191cafe-0000-7000-8000-000000000002",
      userId: "0191cafe-0000-7000-8000-000000000002",
      scopes: ["*"],
      authType: "dev",
    };
    return true;
  }
}

@Module({
  controllers: [IngestController],
  providers: [
    IngestService,
    { provide: ARCHIVE_STORE, useFactory: () => new DevArchiveStore() },
    { provide: OBJECT_STORAGE, useFactory: () => new MemoryObjectStorage() },
    { provide: JOB_QUEUE, useFactory: () => new InMemoryJobQueue() },
    { provide: APP_GUARD, useClass: TestAuthGuard },
  ],
})
class TestIngestModule {}

function httpServer(application: INestApplication): Server {
  const candidate = application.getHttpServer() as Server | undefined;
  if (!(candidate instanceof Server)) throw new Error("Nest HTTP server was not initialized");
  return candidate;
}

describe("binary raw ingest HTTP", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(TestIngestModule, { logger: false, rawBody: true, abortOnError: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => { if (app) await app.close(); });

  it("round-trips a multi-megabyte octet stream and returns 201 then 208", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 37, 0xa5);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const endpoint = `/v1/ingest/artifacts/${sha256}`;
    const headers = {
      "content-type": "application/octet-stream",
      "x-memoar-source": "claude-code",
      "x-memoar-source-path": "/tmp/session.jsonl",
      "x-memoar-tenant": "0191cafe-0000-7000-8000-000000000002",
      "x-memoar-user": "0191cafe-0000-7000-8000-000000000002",
    };
    await request(httpServer(app)).put(endpoint).set(headers).send(bytes).expect(201);
    await request(httpServer(app)).put(endpoint).set(headers).send(bytes).expect(208);
    const storage = app.get<ObjectStorage>(OBJECT_STORAGE);
    const persisted = await storage.get(`tenants/0191cafe-0000-7000-8000-000000000002/raw/${sha256}`);
    expect(Buffer.from(persisted).equals(bytes)).toBe(true);
  });

  it("rejects manifests referencing artifacts that were never uploaded with a 422 problem", async () => {
    const ghost = "b".repeat(64);
    const response = await request(httpServer(app))
      .post("/v1/ingest/manifests")
      .send({
        machineId: "0191cafe-0000-7000-8000-000000000002",
        batchId: "ghost-batch",
        artifacts: [{ sha256: ghost, size: 10, source: "claude-code@v1", sourcePath: "ghost.jsonl", modifiedAt: "2026-08-19T00:00:00.000Z" }],
      })
      .expect(422);
    expect(response.body).toMatchObject({ code: "missing_artifact_hashes", missing: [ghost] });
  });
});