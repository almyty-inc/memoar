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

/** Narrows what the upload endpoint answers with, since supertest types it `any`. */
function acknowledgement(body: unknown): { id: string; status: string } {
  const { id, status } = (body ?? {}) as { id?: unknown; status?: unknown };
  if (typeof id !== "string" || typeof status !== "string") {
    throw new Error(`expected an id and a status, got ${JSON.stringify(body)}`);
  }
  return { id, status };
}

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

  /*
    An artifact is identified by (tenant, sha256) and the store enforces it, so
    re-offering the same bytes stores nothing new. The id the endpoint reports
    has to be the id of the row that is held — it was minted per request, so a
    duplicate answered with a uuid naming nothing, and a different one each
    time. The agent re-uploads a transcript on every append, which is how one
    artifact came to have been announced under dozens of ids.
  */
  it("reports the held artifact's own id when the same bytes are offered again", async () => {
    const bytes = Buffer.from("the same conversation, offered twice");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const endpoint = `/v1/ingest/artifacts/${sha256}`;
    const headers = {
      "content-type": "application/octet-stream",
      "x-memoar-source": "claude-code",
      "x-memoar-source-path": "/tmp/twice.jsonl",
    };
    const offer = async (expected: number): Promise<{ id: string; status: string }> => {
      const response = await request(httpServer(app)).put(endpoint).set(headers).send(bytes).expect(expected);
      return acknowledgement(response.body);
    };

    const stored = await offer(201);
    const again = await offer(208);
    expect(again.status).toBe("duplicate");
    expect(again.id, "a duplicate names the artifact already held, not a new one").toBe(stored.id);

    // And a third offer agrees with both, rather than inventing a third id.
    expect((await offer(208)).id).toBe(stored.id);
  });

  /*
    The receipt counted the request, not the work. `accepted` was the length of
    the artifact list and `duplicate` was the literal 0, while the queue is
    keyed by (tenant, parse, sha256) and collapses repeats — so a manifest that
    named one file twice, which the agent produces whenever two watched patterns
    resolve to the same path, was acknowledged as two accepted parses and no
    duplicates, and one job existed.
  */
  it("counts a manifest receipt from the jobs it queued, not from the list it was sent", async () => {
    const bytes = Buffer.from("one transcript, named twice in one manifest");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await request(httpServer(app))
      .put(`/v1/ingest/artifacts/${sha256}`)
      .set({ "content-type": "application/octet-stream", "x-memoar-source": "claude-code", "x-memoar-source-path": "/tmp/twice-in-manifest.jsonl" })
      .send(bytes)
      .expect(201);
    const entry = { sha256, size: bytes.byteLength, source: "claude-code@v1", sourcePath: "/tmp/twice-in-manifest.jsonl", modifiedAt: "2026-08-19T00:00:00.000Z" };

    const response = await request(httpServer(app))
      .post("/v1/ingest/manifests")
      .send({ machineId: "0191cafe-0000-7000-8000-000000000002", batchId: "1191cafe-0000-7000-8000-000000000009", artifacts: [entry, entry] })
      .expect(202);

    const queue = app.get<InMemoryJobQueue>(JOB_QUEUE);
    const parses = queue.jobs.filter((job) => job.name === "parse" && job.data.sha256 === sha256);
    expect(parses, "the queue collapses the repeat, so the receipt must too").toHaveLength(1);
    expect(response.body).toMatchObject({ accepted: 1, duplicate: 1 });
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

  it("reports the ingest outcome so a client need not guess why nothing appeared", async () => {
    const bytes = Buffer.from("not any format this archive understands");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await request(httpServer(app))
      .put(`/v1/ingest/artifacts/${sha256}`)
      .set("content-type", "application/octet-stream")
      .set("x-memoar-source", "future-vendor@v9")
      .set("x-memoar-source-path", "future/session.bin")
      .send(bytes)
      .expect(201);

    const stored = await request(httpServer(app)).get(`/v1/ingest/artifacts/${sha256}/status`).expect(200);
    const body = stored.body as { status: string; sha256: string; source: string };
    expect(body.status).toBe("stored");
    expect(body.sha256).toBe(sha256);
    expect(body.source).toBe("future-vendor@v9");
    // The bytes themselves must never come back through this route.
    expect(body).not.toHaveProperty("objectKey");
    expect(JSON.stringify(body)).not.toContain("not any format");
  });

  it("answers 404 for an unknown digest and 400 for one that is not a digest", async () => {
    const absent = createHash("sha256").update("never uploaded").digest("hex");
    await request(httpServer(app)).get(`/v1/ingest/artifacts/${absent}/status`).expect(404);
    await request(httpServer(app)).get("/v1/ingest/artifacts/not-a-digest/status").expect(400);
  });

  /*
    A capture path with non-ASCII in it.

    Node reads a header as latin1, and the agent sent raw UTF-8, so
    `/Users/ünï 日本/x` was archived as `/Users/Ã¼nÃ¯ æ...`. A current agent
    percent-encodes the path. An older one still sends the raw bytes, which this
    server now reads back as the UTF-8 they were. Plain ASCII, the only thing
    that ever arrived intact, is taken exactly as before.
  */
  it("reads the capture path as UTF-8 whether the agent encoded it or not", async () => {
    const path = "/Users/ünï 日本/x.jsonl";
    const cases: { header: string; expected: string }[] = [
      { header: "%2FUsers%2F%C3%BCn%C3%AF%20%E6%97%A5%E6%9C%AC%2Fx.jsonl", expected: path },
      // What an older agent's bytes look like to Node: one character per byte.
      { header: Buffer.from(path, "utf8").toString("latin1"), expected: path },
      // A raw path is never decoded, even one that contains a valid escape.
      { header: "/tmp/100%41.jsonl", expected: "/tmp/100%41.jsonl" },
    ];
    for (const [index, { header, expected }] of cases.entries()) {
      const bytes = Buffer.from(`non-ascii path ${index}`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await request(httpServer(app))
        .put(`/v1/ingest/artifacts/${sha256}`)
        .set("content-type", "application/octet-stream")
        .set("x-memoar-source", "future-vendor@v9")
        .set("x-memoar-source-path", header)
        .send(bytes)
        .expect(201);
      const stored = await request(httpServer(app)).get(`/v1/ingest/artifacts/${sha256}/status`).expect(200);
      expect((stored.body as { sourcePath: string }).sourcePath, header).toBe(expected);
    }
  });

  it("refuses a control character spelled as an escape", async () => {
    const bytes = Buffer.from("escaped control character");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await request(httpServer(app))
      .put(`/v1/ingest/artifacts/${sha256}`)
      .set("content-type", "application/octet-stream")
      .set("x-memoar-source", "future-vendor@v9")
      .set("x-memoar-source-path", "%2Ftmp%2Fa%0Ab")
      .send(bytes)
      .expect(400);
  });
});
