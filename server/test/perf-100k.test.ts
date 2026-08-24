import { execFileSync } from "node:child_process";
import { loadavg, cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./helpers/postgres.js";
import { startTestApi, type TestApi } from "./helpers/http-app.js";

const CONTAINER = "memoar-perf-test";
const PORT = 55982;
const OWNER_URL = `postgres://memoar:memoar-perf@127.0.0.1:${PORT}/memoar`;
const APP_URL = `postgres://memoar_app:memoar_app@127.0.0.1:${PORT}/memoar`;
// Production connects as the least-privilege role, so row-level security is
// evaluated on every query; measuring as the superuser would understate it.
// MEMOAR_PERF_ROLE=owner runs the same benchmark with RLS bypassed, which
// isolates the policy cost from machine contention.
const RUNTIME_ROLE = process.env.MEMOAR_PERF_ROLE === "owner" ? "owner" : "app";
const DATABASE_URL = RUNTIME_ROLE === "owner" ? OWNER_URL : APP_URL;
const TENANT_ID = "0191cafe-0000-7000-8000-000000000002";
const SESSION_COUNT = Number(process.env.MEMOAR_PERF_SESSIONS ?? 100_000);
const P95_BUDGET_MS = Number(process.env.MEMOAR_PERF_P95_BUDGET_MS ?? 300);
const strict = process.env.MEMOAR_PERF_STRICT === "1";

const VOCABULARY = [
  "archive", "parser", "decision", "retention", "vector", "session", "redaction", "transfer",
  "ingest", "manifest", "artifact", "canonical", "distill", "conversion", "workspace", "machine",
  "sharing", "collection", "annotation", "embedding", "hybrid", "lexical", "budget", "policy",
];

// The 100k benchmark takes minutes and needs Docker, so it is opt-in locally
// and always on in CI's data-gates job.
const enabled = process.env.MEMOAR_TEST_PERF === "1" && dockerAvailable();
const suite = enabled ? describe : describe.skip;

let api: TestApi | null = null;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

interface PlanShape {
  readonly nodeTypes: string[];
  readonly indexes: string[];
}

/**
 * Flattens a plan tree into the two facts worth asserting on: which node types
 * appear anywhere in it, and which indexes it actually reaches.
 */
async function explain(database: Client, sql: string, values: readonly unknown[]): Promise<PlanShape> {
  const explained = await database.query<{ "QUERY PLAN": [{ Plan: Record<string, unknown> }] }>(
    `EXPLAIN (FORMAT JSON) ${sql}`, [...values]);
  const nodeTypes: string[] = [];
  const indexes: string[] = [];
  const pending = [explained.rows[0]!["QUERY PLAN"][0].Plan];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (typeof node["Node Type"] === "string") nodeTypes.push(node["Node Type"]);
    if (typeof node["Index Name"] === "string") indexes.push(node["Index Name"]);
    const children = node["Plans"];
    if (Array.isArray(children)) pending.push(...children as Record<string, unknown>[]);
  }
  return { nodeTypes, indexes };
}

/** Machine context so a budget failure is diagnosable rather than mysterious. */
function measurementContext(): string {
  const [one = 0, five = 0] = loadavg();
  return `cpus=${cpus().length} load1=${one.toFixed(2)} load5=${five.toFixed(2)}`;
}

async function seed(): Promise<void> {
  const database = new Client({ connectionString: OWNER_URL });
  await database.connect();
  try {
    await database.query("SET row_security = off");
    await database.query("DROP INDEX IF EXISTS sessions_embedding_idx");
    const wordList = `ARRAY[${VOCABULARY.map((word) => `'${word}'`).join(",")}]`;
    await database.query(`
      INSERT INTO sessions (
        id, "tenantId", source, workspace, "capturedCreatedAt", "capturedUpdatedAt",
        title, summary, models, "tokenTotals", provenance, visibility, "redactionStatus", "searchDocument", embedding, ext
      )
      SELECT
        ('01a01600-' || lpad(to_hex(gs / 65536), 4, '0') || '-7' || lpad(to_hex(gs % 4096), 3, '0') || '-8000-' || lpad(to_hex(gs), 12, '0'))::uuid,
        '${TENANT_ID}'::uuid,
        jsonb_build_object('vendor', 'bench', 'tool', (${wordList})[1 + gs % 4], 'version', 'v1', 'machineId', '0191cafe-0000-7000-8000-000000000001', 'nativeSessionId', 'bench-' || gs),
        jsonb_build_object('path', '/workspace/bench-' || (gs % 50)),
        now() - (gs % 365) * interval '1 day',
        now() - (gs % 365) * interval '1 day',
        'Benchmark ' || (${wordList})[1 + gs % 24] || ' session ' || gs,
        'Synthetic session covering ' || (${wordList})[1 + (gs / 7) % 24] || ' and ' || (${wordList})[1 + (gs / 13) % 24],
        ARRAY['bench-model'],
        '{"input": 10, "output": 20}'::jsonb,
        '[]'::jsonb,
        jsonb_build_object('scope', 'private', 'ownerId', '${TENANT_ID}'),
        'clear',
        (${wordList})[1 + gs % 24] || ' ' || (${wordList})[1 + (gs / 3) % 24] || ' ' || (${wordList})[1 + (gs / 5) % 24] || ' decision detail ' || gs,
        (SELECT ('[' || string_agg(trunc(random() * 1000)::text, ',') || ']') FROM generate_series(1, 768))::vector,
        NULL
      FROM generate_series(1, ${SESSION_COUNT}) gs
      ON CONFLICT (id) DO NOTHING
    `);
    await database.query("SET maintenance_work_mem = '256MB'");
    await database.query("SET max_parallel_maintenance_workers = 0");
    await database.query("CREATE INDEX sessions_embedding_idx ON sessions USING hnsw (embedding vector_cosine_ops)");
    await database.query("ANALYZE sessions");
  } finally {
    await database.end();
  }
}

beforeAll(async () => {
  if (!enabled) return;
  try { docker("rm", "-f", CONTAINER); } catch { /* not running */ }
  docker(
    "run", "-d", "--name", CONTAINER, "--shm-size", "1g",
    "-e", "POSTGRES_DB=memoar", "-e", "POSTGRES_USER=memoar", "-e", "POSTGRES_PASSWORD=memoar-perf",
    "-p", `${PORT}:5432`, "pgvector/pgvector:pg16",
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker("exec", CONTAINER, "pg_isready", "-U", "memoar");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  // Boot the real app against the throwaway database; migrations run on start.
  api = await startTestApi({
    DATABASE_URL,
    MIGRATION_DATABASE_URL: OWNER_URL,
    MEMOAR_RUN_MIGRATIONS: "true",
    MEMOAR_EMBEDDINGS_PROVIDER: "deterministic",
    MEMOAR_TOKEN_SECRET: "perf-benchmark-only",
  });
  await seed();
}, 600_000);

afterAll(async () => {
  if (api) await api.close();
  try { docker("rm", "-f", CONTAINER); } catch { /* already gone */ }
});

suite("hybrid search at 100k sessions", () => {
  it(`keeps p95 under ${P95_BUDGET_MS}ms with every search realizing hybrid retrieval`, async () => {
    const queries = Array.from({ length: 220 }, (_, index) =>
      `${VOCABULARY[index % VOCABULARY.length]!} ${VOCABULARY[(index * 7 + 3) % VOCABULARY.length]!}`);

    for (const query of queries.slice(0, 20)) {
      const warmup = await api!.request("GET", `/search?q=${encodeURIComponent(query)}&mode=hybrid`);
      expect(warmup.status).toBe(200);
    }

    // Same-run baseline: a cheap authenticated round trip through the same
    // process and database. Host load inflates this and the search alike, so
    // the ratio between them stays meaningful when the absolute number is not.
    const baseline: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const startedAt = performance.now();
      const response = await api!.request("GET", "/sessions?limit=1");
      baseline.push(performance.now() - startedAt);
      expect(response.status).toBe(200);
    }

    const samples: number[] = [];
    let hybridRealized = 0;
    for (const query of queries.slice(20)) {
      const startedAt = performance.now();
      const response = await api!.request("GET", `/search?q=${encodeURIComponent(query)}&mode=hybrid`);
      samples.push(performance.now() - startedAt);
      expect(response.status).toBe(200);
      const meta = response.body.meta as { realizedMode?: string } | undefined;
      if (meta?.realizedMode === "hybrid") hybridRealized += 1;
    }

    // A benchmark taken while the host is saturated measures contention, not
    // the code under test. Refuse to report a verdict in that case rather than
    // emitting a misleading number in either direction.
    const [load1 = 0] = loadavg();
    const saturated = load1 > cpus().length * 0.7;

    const p50 = Math.round(percentile(samples, 0.5));
    const p95 = Math.round(percentile(samples, 0.95));
    const p99 = Math.round(percentile(samples, 0.99));
    const baselineP95 = Math.max(1, Math.round(percentile(baseline, 0.95)));
    const ratio = Number((p95 / baselineP95).toFixed(2));
    const summary = `sessions=${SESSION_COUNT} role=${RUNTIME_ROLE} p50=${p50}ms p95=${p95}ms p99=${p99}ms baselineP95=${baselineP95}ms ratio=${ratio}x budget=${P95_BUDGET_MS}ms ${measurementContext()}`;
    console.log(`[perf-100k] ${summary}`);

    expect(hybridRealized, `hybrid retrieval degraded: ${summary}`).toBe(200);

    // The ratio is reported for context only: the baseline is a few
    // milliseconds of fixed overhead, so dividing by it amplifies noise instead
    // of cancelling load. Round-trip count is the load-independent regression
    // guard and is asserted in search-query-count.test.ts.

    // Absolute budget: the real user-facing requirement, but only trustworthy
    // on a machine that is not saturated. CI sets MEMOAR_PERF_STRICT=1 to
    // enforce it unconditionally on its dedicated runner.
    if (strict || !saturated) {
      expect(p95, `p95 over budget: ${summary}`).toBeLessThan(P95_BUDGET_MS);
    } else {
      console.warn(`[perf-100k] absolute budget not enforced: host saturated (${summary})`);
    }
  }, 600_000);

  // A plan is a structural property, like a round-trip count: it has no
  // statistics in it, so it cannot be waved away as machine load. This is the
  // instrument that would have caught the dead vector index, where the index
  // WAS used and a Sort over every candidate row was stacked on top of it —
  // invisible to "did it use the index?" and to a p95 that merely looked slow.
  it("serves vector retrieval from the HNSW index with no sort stacked on top", async () => {
    const database = new Client({ connectionString: APP_URL });
    await database.connect();
    try {
      await database.query("SELECT set_config('memoar.tenant_id', $1, false)", [TENANT_ID]);
      const probe = `[${Array.from({ length: 768 }, (_, index) => index % 7).join(",")}]`;

      const indexed = await explain(database, `
        SELECT id, 1 - (embedding <=> $1::vector) AS score
        FROM sessions
        WHERE "tenantId" = $2 AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 25
      `, [probe, TENANT_ID]);

      expect(indexed.indexes, `plan did not reach the HNSW index: ${indexed.nodeTypes.join(" > ")}`)
        .toContain("sessions_embedding_idx");
      expect(indexed.nodeTypes, `a sort over the candidate set defeats the index: ${indexed.nodeTypes.join(" > ")}`)
        .not.toContain("Sort");

      // Proves the assertion above discriminates rather than passing vacuously:
      // the exact defect we shipped once — a tiebreaker appended to the
      // ordering — must still produce the Sort the real query must not have.
      const tiebroken = await explain(database, `
        SELECT id, 1 - (embedding <=> $1::vector) AS score
        FROM sessions
        WHERE "tenantId" = $2 AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector, id
        LIMIT 25
      `, [probe, TENANT_ID]);
      expect(tiebroken.nodeTypes, "sabotage plan lost its Sort, so the check above proves nothing")
        .toContain("Sort");
    } finally {
      await database.end();
    }
  }, 120_000);
});
