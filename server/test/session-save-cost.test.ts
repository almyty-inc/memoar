import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DataSource, type Logger } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { ENTITIES } from "../src/entities.js";
import { DefaultPipelineSeedFactory, IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";
import { FormatDetector, SecretScanner } from "../src/ingest/detection.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { TEST_CONTEXT } from "./fixtures/archive.js";
import { syntheticClaudeTranscript } from "./helpers/claude-transcript.js";
import { appRoleUrl, connectWithRetry, dockerAvailable, PostgresFixture, queryRows, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

/**
 * What saving a transcript costs the database.
 *
 * The dev worker parsed about one artifact a minute. Two things made a save
 * scale with the wrong numbers:
 *
 * - Turns and blocks were written with `save()`, which reads each row back by
 *   id before inserting it. A 100 MB transcript cost over 100,000 statements.
 * - `content_blocks.turnId` had no index, so deleting a session's turns before
 *   rewriting them walked a whole index per turn through the ON DELETE CASCADE.
 *   That made a re-capture cost its turns times every block in the archive.
 *
 * Statements are counted with a TypeORM logger rather than by wrapping
 * `manager.query`, because repository calls never pass through that method and
 * a proxy on it counted none of the per-row statements.
 *
 * Run as memoar_app, the role the worker uses, so row-level security and the
 * cross-account id probe are part of what is measured.
 */
const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;
const FIXTURE = new PostgresFixture("memoar-session-save-cost-test");
const CONTEXT: TenantContext = { ...TEST_CONTEXT, machineId: "0191cafe-0000-7000-8000-0000000000f3" };
/** Blocks belonging to other sessions, so lookups that scan the table show it. */
const BACKGROUND_BLOCKS = 100_000;

let statements = 0;
const logger: Logger = {
  logQuery: () => { statements += 1; },
  logQueryError: () => undefined,
  logQuerySlow: () => undefined,
  logSchemaBuild: () => undefined,
  logMigration: () => undefined,
  log: () => undefined,
};

let owner: DataSource | null = null;
let runtime: DataSource | null = null;
let store: PostgresArchiveStore;
let pipeline: IngestPipeline;
const objects = new MemoryObjectStorage();

beforeAll(async () => {
  if (!usePostgres) return;
  owner = await startPostgres(FIXTURE);
  await seedAccount(owner, { userId: CONTEXT.userId, tenantId: CONTEXT.tenantId, email: "save-cost@example.test" });
  runtime = new DataSource({ type: "postgres", url: appRoleUrl(FIXTURE), entities: [...ENTITIES], synchronize: false, logging: ["query"], logger });
  await connectWithRetry(runtime, FIXTURE);
  store = new PostgresArchiveStore(runtime);
  await store.saveMachine(CONTEXT, { id: CONTEXT.machineId!, tenantId: CONTEXT.tenantId, name: "cost", platform: "linux", agentVersion: "test", sourceSettings: {}, lastSeenAt: null });
  pipeline = new IngestPipeline(store, objects, new ParserRegistry(), new FormatDetector(), new SecretScanner(), new DefaultPipelineSeedFactory());

  // One small session, then a hundred thousand turns and blocks under it,
  // written directly because writing them through the store is what is slow.
  const [background] = await ingest(syntheticClaudeTranscript({ targetBytes: 20_000, seed: "background" }), "background.jsonl");
  await owner.query(
    `INSERT INTO turns (id, "tenantId", "sessionId", ordinal, role, "capturedAt")
     SELECT gen_random_uuid(), $1, $2, 100000 + g, 'user', now() FROM generate_series(1, $3) g`,
    [CONTEXT.tenantId, background, BACKGROUND_BLOCKS],
  );
  await owner.query(
    `INSERT INTO content_blocks (id, "tenantId", "sessionId", "turnId", ordinal, kind, text)
     SELECT gen_random_uuid(), "tenantId", "sessionId", id, 0, 'text', 'background ' || ordinal FROM turns WHERE ordinal > 100000`,
  );
  await owner.query("ANALYZE");
}, 300_000);

afterAll(async () => {
  if (runtime?.isInitialized) await runtime.destroy();
  await stopPostgres(owner, FIXTURE);
});

/** Stores a transcript as the agent would and parses it, returning its session ids. */
async function ingest(bytes: Buffer, sourcePath: string): Promise<string[]> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `tenants/${CONTEXT.tenantId}/raw/${sha256}`;
  await objects.put(objectKey, bytes);
  await store.saveRawArtifact(CONTEXT, {
    id: randomUUID(), tenantId: CONTEXT.tenantId, sessionIds: [], sha256, size: bytes.byteLength, objectKey,
    status: "stored", source: "claude-code@v1", sourcePath, capturedAt: "2026-11-25T13:00:00.000Z", diagnostic: null,
  });
  const result = await pipeline.process(CONTEXT, sha256);
  expect(result.status).toBe("parsed");
  return result.sessionIds;
}

/** Statements issued and milliseconds taken by one ingest. */
async function measure(bytes: Buffer, sourcePath: string): Promise<{ statements: number; ms: number; sessionIds: string[] }> {
  statements = 0;
  const started = performance.now();
  const sessionIds = await ingest(bytes, sourcePath);
  return { statements, ms: performance.now() - started, sessionIds };
}

suite("session save cost", () => {
  it("issues a number of statements that does not grow with the transcript", async () => {
    const small = await measure(syntheticClaudeTranscript({ targetBytes: 250_000, seed: "small" }), "small.jsonl");
    const large = await measure(syntheticClaudeTranscript({ targetBytes: 4_000_000, seed: "large" }), "large.jsonl");
    const turns = (await queryRows<{ count: number }>(owner!, `SELECT count(*)::int AS count FROM turns WHERE "sessionId" = $1`, large.sessionIds))[0]!.count;

    // About a thousand turns and fifteen hundred blocks. Written row by row,
    // this was about four thousand statements, against a few dozen now.
    expect(turns).toBeGreaterThan(900);
    expect(large.statements, `${small.statements} statements for 250 KB, ${large.statements} for 4 MB`).toBeLessThan(small.statements + 10);
    expect(large.statements).toBeLessThan(60);
  }, 120_000);

  it("keeps the session's turns, blocks and parent links intact", async () => {
    const bytes = syntheticClaudeTranscript({ targetBytes: 300_000, seed: "intact" });
    const [sessionId] = await ingest(bytes, "intact.jsonl");
    const session = await store.getSession(CONTEXT, sessionId!);
    const lines = bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as { uuid: string; parentUuid: string | null; message: { content: unknown[] } });
    expect(session?.turns.map((turn) => turn.id)).toEqual(lines.map((line) => line.uuid));
    expect(session?.turns.map((turn) => turn.parentId)).toEqual(lines.map((line) => line.parentUuid));
    expect(session?.turns.map((turn) => turn.blocks.length)).toEqual(lines.map((line) => line.message.content.length));
    expect(session?.turns[1]?.blocks[1]).toMatchObject({ kind: "tool_call", name: "Bash", data: { command: "grep -rn archive src" } });
  }, 120_000);

  it("re-captures a growing transcript in time that does not depend on the rest of the archive", async () => {
    // The agent re-sends a transcript every time it grows, so the save that
    // replaces a session's rows is the common one. Each deleted turn used to
    // walk every block in the archive.
    const first = await measure(syntheticClaudeTranscript({ targetBytes: 10_000_000, seed: "growing" }), "growing.jsonl");
    const again = await measure(syntheticClaudeTranscript({ targetBytes: 10_300_000, seed: "growing" }), "growing.jsonl");
    expect(again.sessionIds).toEqual(first.sessionIds);
    // Generous, since this shares a machine with every other suite. Before the
    // fix the re-capture took 16 seconds on a laptop, and under one after it.
    expect(again.ms, `${first.ms.toFixed(0)} ms first capture, ${again.ms.toFixed(0)} ms re-capture`).toBeLessThan(6_000);
  }, 300_000);

  it("indexes every foreign key a session save deletes through", async () => {
    // Structural rather than timed: an ON DELETE CASCADE whose referencing
    // column has no index of its own scans for every deleted parent row.
    const uncovered = await queryRows<{ constraint: string }>(owner!, `
      SELECT c.conname AS constraint
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.conrelid IN ('turns'::regclass, 'content_blocks'::regclass)
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid
              AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] = c.conkey
         )`);
    expect(uncovered.map((row) => row.constraint)).toEqual([]);
  });
});
