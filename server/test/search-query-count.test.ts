import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_CONTEXT, DEMO_SESSION } from "../src/demo-data.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { PostgresFtsBackend } from "../src/search.js";
import { DisabledSemanticSearchProvider } from "../src/search.js";
import { SearchService } from "../src/search.js";
import { dockerAvailable, queryRows, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;
const FIXTURE = { container: "memoar-query-count-test", port: 55983 };
const RESULT_COUNT = 25;

let dataSource: DataSource | null = null;
let queries: string[] = [];

/**
 * Wraps the data source so every SQL statement issued during a search is
 * recorded. Latency benchmarks are load-sensitive; a round-trip count is not,
 * which makes this the durable guard against an N+1 creeping back into search.
 */
function countingDataSource(inner: DataSource): DataSource {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "query") {
        return async (sql: string, parameters?: unknown[]) => {
          queries.push(sql.trim().split("\n")[0]!.slice(0, 60));
          return (target.query as (s: string, p?: unknown[]) => Promise<unknown>)(sql, parameters);
        };
      }
      if (property === "transaction") {
        return async (runner: (manager: unknown) => Promise<unknown>) =>
          (target.transaction as (r: (m: unknown) => Promise<unknown>) => Promise<unknown>)(async (manager) => {
            const managerProxy = new Proxy(manager as object, {
              get(managerTarget, managerProperty, managerReceiver) {
                if (managerProperty === "query") {
                  return async (sql: string, parameters?: unknown[]) => {
                    queries.push(sql.trim().split("\n")[0]!.slice(0, 60));
                    return (Reflect.get(managerTarget, "query", managerReceiver) as (s: string, p?: unknown[]) => Promise<unknown>).call(managerTarget, sql, parameters);
                  };
                }
                return Reflect.get(managerTarget, managerProperty, managerReceiver) as unknown;
              },
            });
            return runner(managerProxy);
          });
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

beforeAll(async () => {
  if (!usePostgres) return;
  dataSource = await startPostgres(FIXTURE);
  await seedAccount(dataSource, { userId: DEMO_CONTEXT.userId, tenantId: DEMO_CONTEXT.tenantId, email: "count@example.test" });
  const store = new PostgresArchiveStore(dataSource);
  for (let index = 0; index < RESULT_COUNT + 5; index += 1) {
    const session = structuredClone(DEMO_SESSION);
    const suffix = String(index).padStart(12, "0");
    session.id = `01a01700-0000-7000-8000-${suffix}`;
    session.title = `archive decision session ${index}`;
    session.source = { ...session.source, nativeSessionId: `count-${index}` };
    // Turn and block ids are primary keys, so clones must not share them or
    // each save moves the previous session's rows onto the newest session.
    session.turns = session.turns.map((turn, turnIndex) => ({
      ...turn,
      id: `01a01701-${String(turnIndex).padStart(4, "0")}-7000-8000-${suffix}`,
      parentId: turnIndex === 0 ? null : `01a01701-${String(turnIndex - 1).padStart(4, "0")}-7000-8000-${suffix}`,
      blocks: turn.blocks.map((block, blockIndex) => ({
        ...block,
        id: `01a01702-${String(turnIndex).padStart(2, "0")}${String(blockIndex).padStart(2, "0")}-7000-8000-${suffix}`,
      })),
    }));
    await store.saveSession(DEMO_CONTEXT, session);
  }

  // Assert the seeded SHAPE, not just that the loop ran. Cloning a fixture and
  // changing only the parent id silently reparents children whenever child ids
  // are primary keys: every save still "succeeds" while earlier sessions quietly
  // lose their turns.
  const shape = await queryRows<{ sessions: number; turns: number; orphans: number }>(dataSource, `
    SELECT
      (SELECT count(*)::int FROM sessions) AS sessions,
      (SELECT count(*)::int FROM turns) AS turns,
      (SELECT count(*)::int FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM turns t WHERE t."sessionId" = s.id)) AS orphans
  `);
  const seeded = shape[0]!;
  if (seeded.sessions !== RESULT_COUNT + 5) throw new Error(`seeded ${seeded.sessions} sessions, expected ${RESULT_COUNT + 5}`);
  if (seeded.turns !== seeded.sessions * DEMO_SESSION.turns.length) {
    throw new Error(`seeded ${seeded.turns} turns, expected ${seeded.sessions * DEMO_SESSION.turns.length}`);
  }
  if (seeded.orphans !== 0) throw new Error(`${seeded.orphans} seeded sessions have no turns`);
}, 180_000);

afterAll(async () => { await stopPostgres(dataSource, FIXTURE); });

suite("search hydration cost", () => {
  it("issues a bounded number of round trips regardless of how many results it hydrates", async () => {
    const counted = countingDataSource(dataSource!);
    const store = new PostgresArchiveStore(counted);
    const service = new SearchService(new PostgresFtsBackend(counted, store), new DisabledSemanticSearchProvider());

    queries = [];
    const result = await service.execute(DEMO_CONTEXT, "archive decision", "lexical", {}, RESULT_COUNT);
    expect(result.candidates.length).toBeGreaterThan(5);

    // Hydrating one session at a time cost a transaction plus three queries
    // each; at 25 results that was ~100 statements for a single search.
    expect(queries.length, `queries issued:\n${queries.join("\n")}`).toBeLessThan(12);
  }, 60_000);

  it("returns excerpts as plain text so the client can highlight them safely", async () => {
    const store = new PostgresArchiveStore(dataSource!);
    const service = new SearchService(new PostgresFtsBackend(dataSource!, store), new DisabledSemanticSearchProvider());
    const result = await service.execute(DEMO_CONTEXT, "archive decision", "lexical", {}, 10);
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      // ts_headline marks matches with <b> by default. The client renders the
      // excerpt as text, so any markup here reaches the user as literal
      // characters like "<b>archive</b>".
      expect(candidate.highlight, `excerpt carried markup: ${candidate.highlight}`).not.toMatch(/<\/?[a-z]/i);
    }
  }, 60_000);

  it("hydrates in bulk without losing ranking order or dropping results", async () => {
    const store = new PostgresArchiveStore(dataSource!);
    const ids = [
      "01a01700-0000-7000-8000-000000000003",
      "01a01700-0000-7000-8000-000000000001",
      "01a01700-0000-7000-8000-00000000dead",
      "01a01700-0000-7000-8000-000000000002",
    ];
    const hydrated = await store.getSessions(DEMO_CONTEXT, ids);
    expect(hydrated[0]?.turns.length).toBe(DEMO_SESSION.turns.length);
    // Order follows the caller's ranking; unknown ids are skipped, not null.
    expect(hydrated.map((session) => session.id)).toEqual([ids[0], ids[1], ids[3]]);
    expect(hydrated[0]!.turns.length).toBe(DEMO_SESSION.turns.length);
    expect(hydrated[0]!.turns[0]!.blocks[0]!.text).toBe(DEMO_SESSION.turns[0]!.blocks[0]!.text);
  }, 60_000);

  it("returns nothing for an empty id list without touching the database", async () => {
    const counted = countingDataSource(dataSource!);
    queries = [];
    expect(await new PostgresArchiveStore(counted).getSessions(DEMO_CONTEXT, [])).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("keeps the in-memory store's batch hydration behaviourally identical", async () => {
    const { DevArchiveStore } = await import("../src/dev-archive-store.js");
    const memory = new DevArchiveStore();
    const postgres = new PostgresArchiveStore(dataSource!);
    const session = structuredClone(DEMO_SESSION);
    session.id = "01a01700-0000-7000-8000-000000000001";
    await memory.saveSession(DEMO_CONTEXT, session);

    const fromMemory = await memory.getSessions(DEMO_CONTEXT, [session.id, "01a01700-0000-7000-8000-00000000dead"]);
    const fromPostgres = await postgres.getSessions(DEMO_CONTEXT, [session.id, "01a01700-0000-7000-8000-00000000dead"]);
    expect(fromMemory.map((item) => item.id)).toEqual(fromPostgres.map((item) => item.id));
  }, 60_000);
});
