import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchiveStore, RawArtifactRecord, TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { dockerAvailable, PostgresFixture, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

/*
  The two store methods the session identity fix leans on, held to one
  behaviour in both stores. The memory store is what the pipeline tests run
  against and Postgres is what dev runs, so a difference between them is a fix
  that passes here and does nothing there.
*/

const FIXTURE = new PostgresFixture("memoar-session-identity-test");
const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
let dataSource: DataSource | null = null;
const context: TenantContext = TEST_CONTEXT;

beforeAll(async () => {
  if (!usePostgres) return;
  dataSource = await startPostgres(FIXTURE);
  await seedAccount(dataSource, { userId: context.userId, tenantId: context.tenantId, email: "identity@example.test" });
}, 180_000);

afterAll(async () => { await stopPostgres(dataSource, FIXTURE); });

const implementations: { name: string; prefix: string; skip: boolean; create: () => ArchiveStore }[] = [
  { name: "memory", prefix: "a", skip: false, create: () => new DevArchiveStore() },
  { name: "postgres", prefix: "b", skip: !usePostgres, create: () => new PostgresArchiveStore(dataSource!) },
];

for (const implementation of implementations) {
  const suite = implementation.skip ? describe.skip : describe;
  /** Ids unique to this implementation, because the Postgres database outlives each test. */
  const id = (suffix: string) => `0191cafe-0000-7000-8000-0000${implementation.prefix}${suffix.padStart(7, "0")}`;
  const sha = (letter: string) => `${implementation.prefix}${letter}`.padEnd(64, letter);

  function artifact(letter: string, overrides: Partial<RawArtifactRecord>): RawArtifactRecord {
    return {
      id: id(`a${letter.charCodeAt(0)}`), tenantId: context.tenantId, sessionIds: [], sha256: sha(letter), size: 1,
      objectKey: `raw/${sha(letter)}`, status: "parsed", source: "claude-code", sourcePath: `/p/${implementation.name}/s.jsonl`,
      capturedAt: "2026-11-25T12:00:00.000Z", diagnostic: null, ...overrides,
    };
  }

  suite(`session identity: ${implementation.name}`, () => {
    it("never hands a new identity a session another identity holds", async () => {
      const store = implementation.create();
      const parent = { sourceTool: "claude-code", sourceVersion: "v1", nativeSessionId: `parent-${implementation.name}` };
      const subagent = { sourceTool: "claude-code", sourceVersion: "v1", nativeSessionId: `parent-${implementation.name}:agent:a1` };
      const parentSession = await store.resolveSessionIdentity(context, parent, id("1"));
      expect(parentSession).toBe(id("1"));

      // What a re-parse proposes: the session the artifact was merged into, then its own.
      const subagentSession = await store.resolveSessionIdentity(context, subagent, [parentSession, id("2")]);
      expect(subagentSession).toBe(id("2"));
      expect(await store.resolveSessionIdentity(context, subagent, [id("3")]), "and it stays put afterwards").toBe(id("2"));
      expect(await store.resolveSessionIdentity(context, parent, id("4"))).toBe(id("1"));
    });

    it("mints a fresh session when every proposal is taken", async () => {
      const store = implementation.create();
      const taken = await store.resolveSessionIdentity(context, { sourceTool: "codex", sourceVersion: "v1", nativeSessionId: `one-${implementation.name}` }, id("5"));
      const other = await store.resolveSessionIdentity(context, { sourceTool: "codex", sourceVersion: "v1", nativeSessionId: `two-${implementation.name}` }, [taken]);
      expect(other).not.toBe(taken);
      expect(other).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    });

    it("says when a session already holds a later capture of the same file", async () => {
      const store = implementation.create();
      const session = { ...structuredClone(TEST_SESSION), id: id("6") };
      await store.saveSession(context, session);
      const older = artifact("c", { capturedAt: "2026-11-25T12:00:00.000Z" });
      const newer = artifact("d", { capturedAt: "2026-11-25T13:00:00.000Z" });
      const elsewhere = artifact("e", { capturedAt: "2026-11-25T14:00:00.000Z", sourcePath: `/p/${implementation.name}/other.jsonl` });
      for (const record of [older, newer, elsewhere]) await store.saveRawArtifact(context, { ...record, status: "stored" });

      expect(await store.hasNewerCapture(context, session.id, older), "nothing is linked yet").toBe(false);
      await store.updateRawArtifact(context, { ...newer, sessionIds: [session.id] });
      await store.updateRawArtifact(context, { ...elsewhere, sessionIds: [session.id] });

      expect(await store.hasNewerCapture(context, session.id, older)).toBe(true);
      expect(await store.hasNewerCapture(context, session.id, newer), "a capture is never newer than itself").toBe(false);
      expect(await store.hasNewerCapture(context, id("7"), older), "another session's captures do not count").toBe(false);
      expect(await store.hasNewerCapture(context, session.id, { ...older, sourcePath: null }), "an upload has no file to compare").toBe(false);

      await store.updateRawArtifact(context, { ...newer, sessionIds: [session.id], status: "failed" });
      expect(await store.hasNewerCapture(context, session.id, older), "a capture that failed to parse holds nothing").toBe(false);
    });

    it("reads the parser and machine of every session without its turns", async () => {
      const store = implementation.create();
      const session = {
        ...structuredClone(TEST_SESSION),
        id: id("8"),
        provenance: [{ kind: "native" as const, capturedAt: "2026-11-25T12:00:00.000Z", parserVersion: "codex:rollout-v1:0.3.0" }],
      };
      await store.saveSession(context, session);
      expect((await store.sessionParserVersions(context)).get(session.id))
        .toEqual({ parserVersion: "codex:rollout-v1:0.3.0", machineId: session.source.machineId });
    });
  });
}
