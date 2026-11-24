import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchivedSession } from "../src/archive-store.js";
import { SourcePathUtf81700000021000 } from "../src/migrations/1700000021000-SourcePathUtf8.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { dockerAvailable, queryRows, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

/**
 * The repair of capture paths stored as latin1 readings of UTF-8.
 *
 * Rows are written the way the old server wrote them, garbled, and the
 * migration is then run against them a second time, as the deploy job would
 * on a database that already has every earlier migration.
 */
const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;
const FIXTURE = { container: "memoar-source-path-migration-test", port: 55995 };

const MACHINE = "0191cafe-0000-7000-8000-0000000000e3";
const PATH = "/Users/ünï 日本/session.jsonl";
const GARBLED = Buffer.from(PATH, "utf8").toString("latin1");

let owner: DataSource | null = null;

beforeAll(async () => {
  if (!usePostgres) return;
  owner = await startPostgres(FIXTURE);
  await seedAccount(owner, { userId: TEST_CONTEXT.userId, tenantId: TEST_CONTEXT.tenantId, email: "paths@example.test" });
}, 300_000);

afterAll(async () => { await stopPostgres(owner, FIXTURE); });

function session(id: string, workspacePath: string, nativeSessionId: string): ArchivedSession {
  const value = structuredClone(TEST_SESSION);
  value.id = id;
  value.source = { ...value.source, nativeSessionId };
  value.workspace = { path: workspacePath };
  value.turns = value.turns.map((turn, index) => ({
    ...turn,
    id: `${id.slice(0, 24)}${(0xa00 + index).toString(16).padStart(12, "0")}`,
    parentId: null,
    blocks: turn.blocks.map((block, blockIndex) => ({ ...block, id: `${id.slice(0, 24)}${(0xb00 + index * 8 + blockIndex).toString(16).padStart(12, "0")}` })),
  }));
  return value;
}

async function single<T>(sql: string, parameters: unknown[]): Promise<T> {
  return (await queryRows<T>(owner!, sql, parameters))[0]!;
}

suite("repairing garbled capture paths", () => {
  it("restores the UTF-8 path everywhere the header put it, and nowhere else", async () => {
    const store = new PostgresArchiveStore(owner!);
    const native = `path:${MACHINE}:${GARBLED}`;
    await store.saveRawArtifact(TEST_CONTEXT, {
      id: "0191cafe-0000-7000-8000-0000000f0001", tenantId: TEST_CONTEXT.tenantId, sessionIds: [],
      sha256: "f".repeat(64), size: 1, objectKey: "raw/f", status: "parsed", source: "codex",
      sourcePath: GARBLED, capturedAt: "2026-11-01T00:00:00.000Z", diagnostic: null,
    });
    // A session that fell back to the header for both its identity and its workspace.
    await store.saveSession(TEST_CONTEXT, session("0191cafe-0000-7000-8000-0000000f1000", GARBLED, native));
    await store.resolveSessionIdentity(TEST_CONTEXT, { sourceTool: "codex", sourceVersion: "v1", nativeSessionId: native }, "0191cafe-0000-7000-8000-0000000f1000");
    // A session whose transcript named this directory itself. Its body was
    // UTF-8 all along, so a value that merely looks garbled is not touched.
    const lookalike = "/srv/Ã¼ber";
    await store.saveSession(TEST_CONTEXT, session("0191cafe-0000-7000-8000-0000000f2000", lookalike, "own-native-id"));

    const queryRunner = owner!.createQueryRunner();
    try {
      await new SourcePathUtf81700000021000().up(queryRunner);
      // A second run changes nothing.
      await new SourcePathUtf81700000021000().up(queryRunner);
    } finally {
      await queryRunner.release();
    }

    expect((await single<{ path: string }>(`SELECT "sourcePath" AS path FROM raw_artifacts WHERE sha256 = $1`, ["f".repeat(64)])).path).toBe(PATH);
    const repaired = await single<{ path: string; native: string }>(
      `SELECT workspace->>'path' AS path, source->>'nativeSessionId' AS native FROM sessions WHERE id = $1`, ["0191cafe-0000-7000-8000-0000000f1000"]);
    expect(repaired).toEqual({ path: PATH, native: `path:${MACHINE}:${PATH}` });
    const identity = await single<{ native: string; sessionId: string }>(
      `SELECT "nativeSessionId" AS native, "sessionId" FROM session_identities WHERE "sourceTool" = 'codex'`, []);
    expect(identity).toEqual({ native: `path:${MACHINE}:${PATH}`, sessionId: "0191cafe-0000-7000-8000-0000000f1000" });
    expect((await single<{ path: string }>(`SELECT workspace->>'path' AS path FROM sessions WHERE id = $1`, ["0191cafe-0000-7000-8000-0000000f2000"])).path).toBe(lookalike);

    // And the next capture, decoded correctly, lands on the same session.
    expect(await store.resolveSessionIdentity(TEST_CONTEXT, { sourceTool: "codex", sourceVersion: "v1", nativeSessionId: `path:${MACHINE}:${PATH}` }, "0191cafe-0000-7000-8000-0000000f9999"))
      .toBe("0191cafe-0000-7000-8000-0000000f1000");
  });
});
