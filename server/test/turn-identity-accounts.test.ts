import { createHash, randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchivedSession, TenantContext } from "../src/archive-store.js";
import { ENTITIES } from "../src/entities.js";
import { IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { appRoleUrl, dockerAvailable, queryRows, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

/**
 * Two accounts upload the same transcript.
 *
 * Turn ids are a primary key across every account and Claude Code writes real
 * uuids, so the second account's save met the first account's rows and failed
 * with `duplicate key value violates unique constraint "turns_pkey"`. The save
 * already rescoped an id another session of the same account held, but asked
 * as the runtime role, and row-level security hid the other account's rows.
 *
 * Run as that role here, memoar_app, deliberately. The other Postgres suites
 * connect as the owner, which bypasses row-level security and would have seen
 * the colliding rows and passed without the fix.
 */
const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;
const FIXTURE = { container: "memoar-turn-accounts-test", port: 55994 };

function account(suffix: string): TenantContext {
  return {
    tenantId: `0191cafe-0000-7000-8000-0000000a${suffix}01`,
    userId: `0191cafe-0000-7000-8000-0000000a${suffix}02`,
    machineId: `0191cafe-0000-7000-8000-0000000a${suffix}03`,
    scopes: ["*"],
    authType: "machine",
  };
}

const alice = account("a1");
const bob = account("b1");
const NATIVE_SESSION = "0191cafe-0000-7000-8000-0000000ad000";

/** One Claude Code transcript, each turn the child of the one before. */
function transcript(turns: number): Buffer {
  const uuid = (index: number) => `0191cafe-0000-7000-8000-0000000ae${index.toString(16).padStart(3, "0")}`;
  const lines = Array.from({ length: turns }, (_, index) => JSON.stringify({
    type: index % 2 === 0 ? "user" : "assistant",
    uuid: uuid(index),
    parentUuid: index === 0 ? null : uuid(index - 1),
    sessionId: NATIVE_SESSION,
    cwd: "/workspace/shared",
    timestamp: "2026-11-01T00:00:00.000Z",
    message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `turn ${index}` }] },
  }));
  return Buffer.from(`${lines.join("\n")}\n`);
}

let owner: DataSource | null = null;
let runtime: DataSource | null = null;
let store: PostgresArchiveStore;
let pipeline: IngestPipeline;
const objects = new MemoryObjectStorage();

beforeAll(async () => {
  if (!usePostgres) return;
  owner = await startPostgres(FIXTURE);
  runtime = new DataSource({ type: "postgres", url: appRoleUrl(FIXTURE), entities: [...ENTITIES], synchronize: false });
  await runtime.initialize();
  store = new PostgresArchiveStore(runtime);
  pipeline = new IngestPipeline(store, objects);
  for (const [context, email] of [[alice, "alice@example.test"], [bob, "bob@example.test"]] as const) {
    await seedAccount(owner, { userId: context.userId, tenantId: context.tenantId, email });
    await store.saveMachine(context, {
      id: context.machineId!, tenantId: context.tenantId, name: "laptop", platform: "linux",
      agentVersion: "test", sourceSettings: {}, lastSeenAt: null,
    });
  }
}, 300_000);

afterAll(async () => {
  if (runtime?.isInitialized) await runtime.destroy();
  await stopPostgres(owner, FIXTURE);
});

/** Uploads and parses a transcript as one account, as the agent would. */
async function ingest(context: TenantContext, bytes: Buffer): Promise<ArchivedSession> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `tenants/${context.tenantId}/raw/${sha256}`;
  await objects.put(objectKey, bytes);
  await store.saveRawArtifact(context, {
    id: randomUUID(), tenantId: context.tenantId, sessionIds: [], sha256, size: bytes.byteLength, objectKey,
    status: "stored", source: "claude-code@v1", sourcePath: "/workspace/shared/session.jsonl",
    capturedAt: "2026-11-01T00:00:00.000Z", diagnostic: null,
  });
  const result = await pipeline.process(context, sha256);
  if (result.status !== "parsed") throw new Error(`ingest ${result.status}: ${(await store.getRawArtifact(context, sha256))?.diagnostic ?? ""}`);
  expect(result.sessionIds).toHaveLength(1);
  const session = await store.getSession(context, result.sessionIds[0]!);
  return session!;
}

/** Every turn present, in order, with its own text, and linked to the turn before it in the same session. */
function expectWhole(session: ArchivedSession, turns: number): void {
  expect(session.turns.map((turn) => turn.blocks[0]?.text)).toEqual(Array.from({ length: turns }, (_, index) => `turn ${index}`));
  session.turns.forEach((turn, index) => {
    expect(turn.parentId, `turn ${index} must point at its own session's turn`).toBe(index === 0 ? null : session.turns[index - 1]!.id);
  });
}

/** The text of the turn an annotation is anchored to, read back from its own session. */
async function anchoredText(context: TenantContext, session: ArchivedSession, annotationId: string): Promise<string | undefined> {
  const annotation = (await store.listAnnotations(context, session.id)).find((candidate) => candidate.id === annotationId);
  const fresh = await store.getSession(context, session.id);
  return fresh?.turns.find((turn) => turn.id === annotation?.turnId)?.blocks[0]?.text;
}

suite("two accounts archiving the same transcript", () => {
  let aliceSession: ArchivedSession;
  let bobSession: ArchivedSession;
  let aliceNote: string;
  let bobNote: string;

  it("keeps both sessions whole, each with its own turn rows", async () => {
    aliceSession = await ingest(alice, transcript(6));
    bobSession = await ingest(bob, transcript(6));

    expectWhole(aliceSession, 6);
    expectWhole(bobSession, 6);
    expect(aliceSession.id).not.toBe(bobSession.id);
    // The account that held the ids first keeps them. Nothing stored moves.
    expect(aliceSession.turns[0]!.id).toBe("0191cafe-0000-7000-8000-0000000ae000");
    const aliceIds = new Set(aliceSession.turns.map((turn) => turn.id));
    expect(bobSession.turns.some((turn) => aliceIds.has(turn.id)), "the second account must not share a turn row").toBe(false);

    const rows = await queryRows<{ tenantId: string; count: number }>(owner!,
      `SELECT "tenantId", count(*)::int AS count FROM turns WHERE "sessionId" = ANY($1) GROUP BY 1 ORDER BY 1`,
      [[aliceSession.id, bobSession.id]]);
    expect(rows).toEqual([{ tenantId: alice.tenantId, count: 6 }, { tenantId: bob.tenantId, count: 6 }]);
  });

  it("anchors each account's annotations to its own turn, through a re-capture", async () => {
    aliceNote = (await store.createAnnotation(alice, { sessionId: aliceSession.id, turnId: aliceSession.turns[2]!.id, kind: "note", value: { text: "alice" } })).id;
    bobNote = (await store.createAnnotation(bob, { sessionId: bobSession.id, turnId: bobSession.turns[2]!.id, kind: "note", value: { text: "bob" } })).id;

    // The transcript grew, and both agents upload it again.
    const aliceGrown = await ingest(alice, transcript(8));
    const bobGrown = await ingest(bob, transcript(8));
    expectWhole(aliceGrown, 8);
    expectWhole(bobGrown, 8);
    expect(aliceGrown.turns.slice(0, 6).map((turn) => turn.id), "a re-capture renumbered the first account").toEqual(aliceSession.turns.map((turn) => turn.id));
    expect(bobGrown.turns.slice(0, 6).map((turn) => turn.id), "a re-capture renumbered the second account").toEqual(bobSession.turns.map((turn) => turn.id));

    expect(await anchoredText(alice, aliceGrown, aliceNote)).toBe("turn 2");
    expect(await anchoredText(bob, bobGrown, bobNote)).toBe("turn 2");
  });

  it("keeps the rescoped ids after the first account deletes its copy", async () => {
    expect(await store.deleteSession(alice, aliceSession.id)).toBe(true);
    const bobAgain = await ingest(bob, transcript(9));
    expectWhole(bobAgain, 9);
    expect(bobAgain.turns.slice(0, 6).map((turn) => turn.id), "the ids changed once nobody else held them").toEqual(bobSession.turns.map((turn) => turn.id));
    expect(await anchoredText(bob, bobAgain, bobNote)).toBe("turn 2");
  });

  it("answers the probe with ids only, and only for the runtime role's own question", async () => {
    // The probe sees past row-level security, so what it returns is the whole
    // exposure: which of the ids the caller already holds exist elsewhere.
    const held = await queryRows<{ id: string }>(runtime!,
      "SELECT id FROM memoar_turn_ids_held_elsewhere($1::uuid[], $2::uuid, $3::uuid) AS id",
      [[bobSession.turns[0]!.id, "0191cafe-0000-7000-8000-0000000aefff"], alice.tenantId, aliceSession.id]);
    expect(held).toEqual([{ id: bobSession.turns[0]!.id }]);
    // And a plain read as the runtime role still sees only its own tenant.
    const visible = await runtime!.transaction(async (manager) => {
      await manager.query("SELECT set_config('memoar.tenant_id', $1, true)", [alice.tenantId]);
      const rows: unknown = await manager.query("SELECT count(*)::int AS count FROM turns");
      return (rows as { count: number }[])[0]?.count;
    });
    expect(visible).toBe(0);
  });
});
