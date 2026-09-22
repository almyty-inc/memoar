import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchivedSession } from "../src/archive-store.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { dockerAvailable, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;
const FIXTURE = { container: "memoar-save-concurrency-test", port: 55989 };

/** WORKER_CONCURRENCY in production, which is what makes this reachable. */
const WORKERS = 4;
const TURNS = 60;
const HAMMER_MS = 12_000;
const SESSION_ID = "0191cafe-0000-7000-8000-00000000f001";

let dataSource: DataSource | null = null;

beforeAll(async () => {
  if (!usePostgres) return;
  dataSource = await startPostgres(FIXTURE);
  await seedAccount(dataSource, {
    userId: TEST_CONTEXT.userId, tenantId: TEST_CONTEXT.tenantId, email: "concurrency@example.test",
  });
}, 180_000);

afterAll(async () => { await stopPostgres(dataSource, FIXTURE); });

function hex(value: number): string {
  return value.toString(16).padStart(12, "0");
}

/**
 * One reading of a transcript that is still being appended to: the turn and
 * block ids are derived from position, so two readings of the same session
 * address the same rows, which is what the agent's re-uploads really do.
 */
function reading(turns: number, salt: number): ArchivedSession {
  return {
    ...structuredClone(TEST_SESSION),
    id: SESSION_ID,
    title: `reading ${salt}`,
    turns: Array.from({ length: turns }, (_, index) => ({
      id: `0191cafe-0000-7000-8000-${hex(0x100000 + index)}`,
      ordinal: index,
      parentId: null,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      createdAt: "2026-08-17T09:00:00.000Z",
      blocks: Array.from({ length: 3 }, (_, blockIndex) => ({
        id: `0191cafe-0000-7000-8000-${hex(0x200000 + index * 8 + blockIndex)}`,
        kind: "text" as const,
        text: `turn ${index} block ${blockIndex}, reading ${salt}`,
      })),
    })),
  };
}

suite("saving one session from several workers at once", () => {
  /*
    Two different artifacts resolving to one canonical session id is the design
    — the agent re-sends a growing transcript as a new sha on every append — so
    with four workers, concurrent saves of one session happen by construction.
    On dev they deadlocked, and 32 artifacts were lost to it.

    The cycle Postgres reported is the session row against one of its content
    blocks, taken in opposite orders: a saver whose DELETE found the rows holds
    the block and wants the session row, while one that arrived a moment later
    deleted nothing, holds the session row, and then finds the blocks still
    there — so its `save()` becomes an UPDATE of a row the first one is holding.

    This hammers the shape rather than pinning an interleaving, because the
    interleaving is what a scheduler decides. Unfixed, it fails within a second
    or two of the first round; the window is long enough that a slow machine
    proves the same thing.
  */
  it("never deadlocks, and never drops a save", { timeout: 120_000 }, async () => {
    const store = new PostgresArchiveStore(dataSource!);
    await store.saveSession(TEST_CONTEXT, reading(TURNS, 0));

    const failures: string[] = [];
    const deadline = Date.now() + HAMMER_MS;
    let saves = 0;
    await Promise.all(Array.from({ length: WORKERS }, async (_, worker) => {
      while (Date.now() < deadline && failures.length === 0) {
        // Staggered, so the workers land inside each other's transactions
        // rather than in lockstep. Lockstep is the one arrangement that cannot
        // deadlock, and it is not the one production runs.
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 40)));
        try {
          await store.saveSession(TEST_CONTEXT, reading(TURNS + (saves % 5), worker + 1));
          saves += 1;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }));

    expect(failures, "a save of one session must not fail because another was saving it").toEqual([]);
    expect(saves, "the hammer has to have actually run").toBeGreaterThan(WORKERS * 4);

    // And what it leaves behind is one whole session, not a merge of readings.
    const saved = await store.getSession(TEST_CONTEXT, SESSION_ID);
    expect(saved!.turns.length).toBeGreaterThanOrEqual(TURNS);
    expect(saved!.turns.every((turn) => turn.blocks.length === 3)).toBe(true);
    const titles = new Set(saved!.turns.flatMap((turn) => turn.blocks.map((block) => block.text!.split("reading ")[1])));
    expect(titles.size, "every block came from the same reading").toBe(1);
  });
});
