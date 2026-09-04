import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { TEST_CONTEXT } from "./fixtures/archive.js";
import { DefaultPipelineSeedFactory, IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { FormatDetector, SecretScanner } from "../src/ingest/detection.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { dockerAvailable, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;
const FIXTURE = { container: "memoar-ingest-throughput-test", port: 55984 };

let dataSource: DataSource | null = null;
let queries: string[] = [];

/** Records every statement so a round trip count can be asserted. */
function countingDataSource(inner: DataSource): DataSource {
  const record = (sql: string) => queries.push(sql.trim().split("\n")[0]!.slice(0, 48));
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "query") {
        return async (sql: string, parameters?: unknown[]) => {
          record(sql);
          return (target.query as (s: string, p?: unknown[]) => Promise<unknown>)(sql, parameters);
        };
      }
      if (property === "transaction") {
        return async (runner: (manager: unknown) => Promise<unknown>) =>
          (target.transaction as (r: (m: unknown) => Promise<unknown>) => Promise<unknown>)(async (manager) => {
            const proxy = new Proxy(manager as object, {
              get(managerTarget, managerProperty, managerReceiver) {
                if (managerProperty === "query") {
                  return async (sql: string, parameters?: unknown[]) => {
                    record(sql);
                    return (Reflect.get(managerTarget, "query", managerReceiver) as (s: string, p?: unknown[]) => Promise<unknown>).call(managerTarget, sql, parameters);
                  };
                }
                return Reflect.get(managerTarget, managerProperty, managerReceiver) as unknown;
              },
            });
            return runner(proxy);
          });
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/** A Claude Code transcript of the requested size, with optional secrets. */
function transcript(turns: number, secrets: number, sessionId = randomUUID()): Buffer {
  const token = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");
  const lines: string[] = [];
  for (let index = 0; index < turns; index += 1) {
    const leaks = index < secrets ? ` deploy with ${token}${index} now` : "";
    lines.push(JSON.stringify({
      type: index % 2 === 0 ? "user" : "assistant",
      uuid: `${sessionId.slice(0, 24)}${(0x1000 + index).toString(16).padStart(12, "0")}`,
      parentUuid: null,
      sessionId,
      cwd: "/workspace/bench",
      gitBranch: "main",
      timestamp: "2026-08-01T00:00:00.000Z",
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn ${index} of a captured session.${leaks}` }],
      },
    }));
  }
  return Buffer.from(`${lines.join("\n")}\n`);
}

let pipeline: IngestPipeline;
let store: PostgresArchiveStore;
let storage: MemoryObjectStorage;

/** A machine context: sessions reference the machine that captured them. */
const CONTEXT: TenantContext = { ...TEST_CONTEXT, machineId: "0191cafe-0000-7000-8000-0000000000e3" };

beforeAll(async () => {
  if (!usePostgres) return;
  dataSource = await startPostgres(FIXTURE);
  await seedAccount(dataSource, { userId: TEST_CONTEXT.userId, tenantId: TEST_CONTEXT.tenantId, email: "ingest@example.test" });
  store = new PostgresArchiveStore(countingDataSource(dataSource));
  await store.saveMachine(CONTEXT, {
    id: CONTEXT.machineId!,
    tenantId: CONTEXT.tenantId,
    name: "throughput",
    platform: "linux",
    agentVersion: "test",
    sourceSettings: {},
    lastSeenAt: null,
  });
  storage = new MemoryObjectStorage();
  pipeline = new IngestPipeline(store, storage, new ParserRegistry(), new FormatDetector(), new SecretScanner(), new DefaultPipelineSeedFactory());
}, 300_000);

afterAll(async () => { await stopPostgres(dataSource, FIXTURE); });

/** Uploads a transcript and runs it through the pipeline, returning the outcome. */
async function ingest(bytes: Buffer, source = "claude-code@v1", sourcePath?: string): Promise<{ status: string; sessionIds: string[] }> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `tenants/${CONTEXT.tenantId}/raw/${sha256}`;
  await storage.put(objectKey, bytes);
  await store.saveRawArtifact(CONTEXT, {
    id: randomUUID(),
    tenantId: CONTEXT.tenantId,
    sessionIds: [],
    sha256,
    size: bytes.byteLength,
    objectKey,
    status: "stored",
    source,
    sourcePath: sourcePath ?? `bench/${sha256.slice(0, 8)}.jsonl`,
    capturedAt: "2026-08-01T00:00:00.000Z",
    diagnostic: null,
  });
  const result = await pipeline.process(CONTEXT, sha256);
  if (result.status !== "parsed") {
    const artifact = await store.getRawArtifact(CONTEXT, sha256);
    throw new Error(`ingest ${result.status}: ${artifact?.diagnostic ?? "no diagnostic"}`);
  }
  return result;
}

suite("ingest", () => {
  it("keeps archiving a conversation as it grows", async () => {
    // The agent re-uploads a session file as it changes, so this is the normal
    // path, not an edge case. A capture used to be identified by the hash of
    // the file, so a grown transcript looked like a new session whose turns
    // already belonged to the first one: the save failed and everything said
    // after the first capture was never archived.
    const sessionId = randomUUID();
    const first = await ingest(transcript(10, 0, sessionId));
    const second = await ingest(transcript(20, 0, sessionId));

    expect(second.sessionIds, "the same conversation must stay one session").toEqual(first.sessionIds);
    const session = await store.getSession(CONTEXT, second.sessionIds[0]!);
    expect(session?.turns).toHaveLength(20);
    expect(session?.source.nativeSessionId, "identity comes from the transcript, not its bytes").toBe(sessionId);
    expect(session?.workspace.path, "the transcript names its own working directory").toBe("/workspace/bench");
  }, 120_000);

  it("keeps one session for a format that keeps its id in the path", async () => {
    // Antigravity writes its transcript under a directory named for the
    // conversation, so the file itself says nothing about which conversation it
    // is. Where a format carries no id, the path is the stable fact — the bytes
    // are not, because they change every time the conversation continues.
    const path = "brain/ee57d0d5-59a8-4ca9-afa7-29ee164eec0e/.system_generated/logs/transcript.jsonl";
    const steps = (count: number) => Buffer.from(`${Array.from({ length: count }, (_, index) => JSON.stringify({
      type: index % 2 === 0 ? "USER_INPUT" : "PLANNER_RESPONSE",
      step_index: index,
      created_at: "2026-08-01T00:00:00.000Z",
      content: `step ${index}`,
    })).join("\n")}\n`);

    const first = await ingest(steps(6), "antigravity-cli@v1", path);
    const second = await ingest(steps(12), "antigravity-cli@v1", path);
    expect(second.sessionIds).toEqual(first.sessionIds);
    expect((await store.getSession(CONTEXT, second.sessionIds[0]!))?.turns).toHaveLength(12);
  }, 120_000);

  it("does not spend a round trip per redaction finding", async () => {
    // Every finding was written with its own insert, so an artifact holding a
    // credential on many lines cost one round trip each — a shape that scales
    // with how leaky a transcript is rather than with how large it is.
    queries = [];
    const clean = await ingest(transcript(40, 0));
    expect(clean.status).toBe("parsed");
    const withoutFindings = queries.length;

    queries = [];
    const leaky = await ingest(transcript(40, 30));
    expect(leaky.status).toBe("parsed");
    const withFindings = queries.length;

    // Thirty findings must not cost thirty extra round trips.
    expect(withFindings - withoutFindings, `${withoutFindings} clean vs ${withFindings} with 30 findings`).toBeLessThan(15);
  }, 120_000);

  it("costs a bounded number of round trips regardless of transcript length", async () => {
    // A count is a structural property: it cannot be explained away by machine
    // load the way a latency figure can.
    queries = [];
    await ingest(transcript(20, 0));
    const small = queries.length;

    queries = [];
    await ingest(transcript(400, 0));
    const large = queries.length;

    expect(large, `${small} round trips for 20 turns, ${large} for 400`).toBeLessThan(small * 3);
  }, 120_000);

  it("keeps a realistic batch within a per-artifact budget", async () => {
    const count = 25;
    const started = performance.now();
    for (let index = 0; index < count; index += 1) {
      const result = await ingest(transcript(60, index % 5 === 0 ? 4 : 0));
      expect(result.status).toBe("parsed");
    }
    const perArtifact = (performance.now() - started) / count;
    // Generous, because this shares a machine with everything else; it exists
    // to catch a change that makes ingest an order of magnitude slower.
    expect(perArtifact, `${perArtifact.toFixed(0)}ms per artifact`).toBeLessThan(2000);
  }, 300_000);
});
