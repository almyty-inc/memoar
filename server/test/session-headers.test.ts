import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchiveStore, ArchivedSession, TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { sessionSummary } from "../src/sessions.js";
import { headerOf } from "../src/store/session-header.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { dockerAvailable, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

const alice: TenantContext = TEST_CONTEXT;
const bob: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000b1",
  userId: "0191cafe-0000-7000-8000-0000000000b2",
  scopes: ["*"],
  authType: "dev",
};

/** An archive of her own, so the counts are not mixed with the other tests' sessions. */
const carol: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000c1",
  userId: "0191cafe-0000-7000-8000-0000000000c2",
  scopes: ["*"],
  authType: "dev",
};

const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
let dataSource: DataSource | null = null;

beforeAll(async () => {
  if (usePostgres) {
    dataSource = await startPostgres();
    await seedAccount(dataSource, { userId: alice.userId, tenantId: alice.tenantId, email: "alice@example.test" });
    await seedAccount(dataSource, { userId: bob.userId, tenantId: bob.tenantId, email: "bob@example.test" });
    await seedAccount(dataSource, { userId: carol.userId, tenantId: carol.tenantId, email: "carol@example.test" });
  }
}, 180_000);

afterAll(async () => { await stopPostgres(dataSource); });

/** A session whose turns span a known number of minutes. */
function session(id: string, updatedAt: string, turnMinutes: readonly number[]): ArchivedSession {
  const base = structuredClone(TEST_SESSION);
  const template = base.turns[0]!;
  const start = Date.parse("2026-08-01T10:00:00.000Z");
  return {
    ...base,
    id,
    updatedAt,
    turns: turnMinutes.map((minute, index) => ({
      ...structuredClone(template),
      id: `${id.slice(0, -4)}${(0xa000 + index).toString(16)}`,
      ordinal: index,
      parentId: null,
      createdAt: new Date(start + minute * 60_000).toISOString(),
      blocks: template.blocks.map((block, blockIndex) => ({ ...block, id: `${id.slice(0, -4)}${(0xb000 + index * 16 + blockIndex).toString(16)}` })),
    })),
  };
}

const implementations: { name: string; skip: boolean; create: () => ArchiveStore }[] = [
  { name: "memory", skip: false, create: () => new DevArchiveStore() },
  { name: "postgres", skip: !usePostgres, create: () => new PostgresArchiveStore(dataSource!) },
];

for (const implementation of implementations) {
  const suite = implementation.skip ? describe.skip : describe;

  /**
   * A list row used to be built from the whole session, turns and blocks
   * included. The header path counts turns in the database instead, so it has
   * to land on exactly the row the full load produced, or the list and the
   * detail view disagree about the same session.
   */
  suite(`session list headers: ${implementation.name}`, () => {
    it("say what the fully loaded sessions say, in the same order and pages", async () => {
      const store = implementation.create();
      const sessions = [
        session(`0191cafe-0000-7000-8000-0000${implementation.name === "postgres" ? "e" : "f"}0000001`, "2026-08-03T00:00:00.000Z", [0, 5, 47]),
        session(`0191cafe-0000-7000-8000-0000${implementation.name === "postgres" ? "e" : "f"}0000002`, "2026-08-02T00:00:00.000Z", [0]),
        session(`0191cafe-0000-7000-8000-0000${implementation.name === "postgres" ? "e" : "f"}0000003`, "2026-08-01T00:00:00.000Z", []),
      ];
      for (const each of sessions) await store.saveSession(alice, each);

      const full = await store.listSessions(alice, { limit: 2 });
      const headers = await store.listSessionHeaders(alice, { limit: 2 });
      expect(headers.total).toBe(3);
      expect(headers.nextCursor).toBe(full.nextCursor);
      expect(headers.items).toEqual(full.items.map(headerOf));
      expect(headers.items.map((item) => item.turnCount)).toEqual([3, 1]);
      expect(sessionSummary(headers.items[0]!)).toEqual(sessionSummary(full.items[0]!));
      expect(sessionSummary(headers.items[0]!).durationMinutes).toBe(47);
      expect(sessionSummary(headers.items[1]!).durationMinutes, "one turn has no duration").toBeUndefined();

      const rest = await store.listSessionHeaders(alice, { limit: 2, cursor: headers.nextCursor! });
      expect(rest.items.map((item) => [item.id, item.turnCount, item.firstTurnAt])).toEqual([[sessions[2]!.id, 0, null]]);
      expect(rest.nextCursor).toBeNull();

      expect((await store.listSessionHeaders(bob, { limit: 10 })).items, "another tenant sees none of them").toEqual([]);

      // Search ranks the ids, so headers come back in the order asked for.
      const ranked = [sessions[2]!.id, "0191cafe-0000-7000-8000-00000000dead", sessions[0]!.id];
      const hits = await store.getSessionHeaders(alice, ranked);
      expect(hits.map((hit) => hit.id)).toEqual([sessions[2]!.id, sessions[0]!.id]);
      expect(hits[1]).toEqual(headerOf((await store.getSession(alice, sessions[0]!.id))!));
      expect(await store.getSessionHeaders(bob, ranked)).toEqual([]);
    });

    it("counts every agent and project in the archive, not one page of it", async () => {
      const store = implementation.create();
      const prefix = `0191cafe-0000-7000-8000-0000${implementation.name === "postgres" ? "d" : "c"}00000`;
      const older = { ...session(`${prefix}11`, "2026-07-01T00:00:00.000Z", [0]), workspace: { path: "/work/old-project" } };
      const newer = { ...session(`${prefix}12`, "2026-08-05T00:00:00.000Z", [0]), workspace: { path: "/work/app" } };
      const other = session(`${prefix}13`, "2026-08-04T00:00:00.000Z", [0]);
      other.workspace = { path: "/work/app" };
      other.source = { ...other.source, tool: "antigravity-cli" };
      for (const each of [older, newer, other]) await store.saveSession(carol, each);

      const facets = await store.sessionFacets(carol);
      expect(facets.workspaces).toEqual([
        { path: "/work/app", sessions: 2, lastUpdatedAt: "2026-08-05T00:00:00.000Z" },
        { path: "/work/old-project", sessions: 1, lastUpdatedAt: "2026-07-01T00:00:00.000Z" },
      ]);
      expect(facets.sources).toEqual([
        { source: TEST_SESSION.source.tool, sessions: 2 },
        { source: "antigravity-cli", sessions: 1 },
      ]);
      expect(await store.sessionFacets(bob)).toEqual({ sources: [], workspaces: [] });
    });
  });
}
