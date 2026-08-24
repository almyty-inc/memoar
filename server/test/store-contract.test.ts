import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchiveStore, RawArtifactRecord, TenantContext } from "../src/archive-store.js";
import { DEMO_CONTEXT, DEMO_SESSION } from "../src/demo-data.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { dockerAvailable, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

const alice: TenantContext = DEMO_CONTEXT;
const bob: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000b1",
  userId: "0191cafe-0000-7000-8000-0000000000b2",
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
  }
}, 180_000);

afterAll(async () => { await stopPostgres(dataSource); });

function artifact(sha: string, sessionIds: string[], tenantId = alice.tenantId): RawArtifactRecord {
  return {
    id: `0191cafe-0000-7000-8000-0000000${sha.slice(0, 5)}`, tenantId, sessionIds, sha256: sha, size: 42,
    objectKey: `raw/${sha}`, status: "parsed", source: "claude-code", sourcePath: "contract/a.jsonl",
    capturedAt: "2026-08-01T00:00:00.000Z", diagnostic: null,
  };
}

/**
 * One behavioral contract, both implementations. The memory store is what unit
 * tests run against; the Postgres store is what production runs. Divergence
 * between them is exactly the class of bug that only showed up live before.
 */
const implementations: { name: string; skip: boolean; create: () => ArchiveStore }[] = [
  { name: "memory", skip: false, create: () => new DevArchiveStore() },
  { name: "postgres", skip: !usePostgres, create: () => new PostgresArchiveStore(dataSource!) },
];

for (const implementation of implementations) {
  const suite = implementation.skip ? describe.skip : describe;

  suite(`ArchiveStore contract: ${implementation.name}`, () => {
    it("round-trips a canonical session and isolates tenants", async () => {
      const store = implementation.create();
      const session = structuredClone(DEMO_SESSION);
      session.id = "0191cafe-0000-7000-8000-0000000c0001";
      await store.saveSession(alice, session);

      const loaded = await store.getSession(alice, session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe(session.title);
      expect(loaded!.turns).toHaveLength(session.turns.length);
      expect(loaded!.turns[0]!.blocks[0]!.text).toBe(session.turns[0]!.blocks[0]!.text);
      expect(loaded!.turns[1]!.parentId).toBe(session.turns[1]!.parentId);

      expect(await store.getSession(bob, session.id)).toBeNull();
      expect((await store.listSessions(bob, { limit: 10 })).items).toHaveLength(0);
    });

    it("resolves a stable canonical id for the same native identity", async () => {
      const store = implementation.create();
      const identity = { sourceTool: "claude-code", sourceVersion: "v1", nativeSessionId: `native-${implementation.name}` };
      const first = await store.resolveSessionIdentity(alice, identity, "0191cafe-0000-7000-8000-0000000c0002");
      const second = await store.resolveSessionIdentity(alice, identity, "0191cafe-0000-7000-8000-0000000c0003");
      expect(second).toBe(first);
    });

    it("updates visibility without rewriting turns", async () => {
      const store = implementation.create();
      const session = structuredClone(DEMO_SESSION);
      session.id = "0191cafe-0000-7000-8000-0000000c0004";
      await store.saveSession(alice, session);

      expect(await store.updateSessionVisibility(alice, session.id, { scope: "team", ownerId: alice.userId, teamId: bob.tenantId })).toBe(true);
      const loaded = await store.getSession(alice, session.id);
      expect(loaded!.visibility).toMatchObject({ scope: "team", teamId: bob.tenantId });
      expect(loaded!.turns).toHaveLength(session.turns.length);
      expect(await store.updateSessionVisibility(alice, "0191cafe-0000-7000-8000-00000000dead", { scope: "private", ownerId: alice.userId })).toBe(false);
    });

    it("stores artifacts with their session joins and reports duplicates", async () => {
      const store = implementation.create();
      const session = structuredClone(DEMO_SESSION);
      session.id = "0191cafe-0000-7000-8000-0000000c0005";
      await store.saveSession(alice, session);
      const sha = "c".repeat(64);

      expect(await store.saveRawArtifact(alice, artifact(sha, []))).toBe(true);
      expect(await store.saveRawArtifact(alice, artifact(sha, []))).toBe(false);
      await store.updateRawArtifact(alice, { ...artifact(sha, [session.id]), status: "parsed" });

      const loaded = await store.getRawArtifact(alice, sha);
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionIds).toEqual([session.id]);
      expect(loaded!.size).toBe(42);
      expect(await store.listArtifactHashes(alice, [sha, "d".repeat(64)])).toEqual(new Set([sha]));
      expect(await store.getRawArtifact(bob, sha)).toBeNull();
    });

    it("keeps tenant settings and the distillation budget consistent", async () => {
      const store = implementation.create();
      expect((await store.getTenantSettings(alice)).retention.policy).toBe("indefinite");
      await store.saveTenantSettings(alice, {
        redaction: { secretScan: true, pathScan: true, emailScan: false, customPatterns: ["ACME_[A-Z]{4}"] },
        retention: { policy: "days", days: 30, exemptCollected: true },
        updatedAt: new Date().toISOString(),
      });
      const settings = await store.getTenantSettings(alice);
      expect(settings.retention).toMatchObject({ policy: "days", days: 30 });
      expect(settings.redaction.customPatterns).toEqual(["ACME_[A-Z]{4}"]);

      await store.saveDistillationSettings(alice, {
        enabled: true, monthlyBudgetCents: 100, monthlySpentCents: 0, budgetWindowStartedAt: new Date().toISOString(),
      });
      expect(await store.reserveDistillationBudget(alice, 60)).toMatchObject({ reserved: true });
      expect(await store.reserveDistillationBudget(alice, 60)).toMatchObject({ reserved: false });
      await store.settleDistillationSpend(alice, -60);
      expect((await store.getDistillationSettings(alice)).monthlySpentCents).toBe(0);

      // Reset so the retention sweep case below controls its own policy.
      await store.saveTenantSettings(alice, {
        redaction: { secretScan: true, pathScan: false, emailScan: false, customPatterns: [] },
        retention: { policy: "indefinite", exemptCollected: true },
        updatedAt: null,
      });
    });

    it("enumerates tenants and applies retention with the collected exemption", async () => {
      const store = implementation.create();
      const stale = structuredClone(DEMO_SESSION);
      stale.id = "0191cafe-0000-7000-8000-0000000c0006";
      stale.updatedAt = "2020-01-01T00:00:00.000Z";
      const staleCollected = structuredClone(DEMO_SESSION);
      staleCollected.id = "0191cafe-0000-7000-8000-0000000c0007";
      staleCollected.updatedAt = "2020-01-01T00:00:00.000Z";
      await store.saveSession(alice, stale);
      await store.saveSession(alice, staleCollected);
      await store.saveCollection(alice, {
        id: "0191cafe-0000-7000-8000-0000000c0008", tenantId: alice.tenantId,
        name: "keep", sessionIds: [staleCollected.id], updatedAt: new Date().toISOString(),
      });

      expect(await store.listTenantIds()).toContain(alice.tenantId);
      const result = await store.applyRetention(alice, "2021-01-01T00:00:00.000Z", true);
      expect(result.deletedSessions).toBe(1);
      expect(await store.getSession(alice, stale.id)).toBeNull();
      expect(await store.getSession(alice, staleCollected.id)).not.toBeNull();
    });

    it("creates teams, resolves accounts by email, and lists team-visible sessions across tenants", async () => {
      const store = implementation.create();
      if (implementation.name === "memory") {
        (store as DevArchiveStore).accountsByEmail.set("bob@example.test", { userId: bob.userId, tenantId: bob.tenantId, email: "bob@example.test" });
      }
      const team = await store.createTeam({ name: `contract-${implementation.name}` }, { userId: alice.userId, tenantId: alice.tenantId, email: "alice@example.test" });
      expect(team.memberCount).toBe(1);
      expect(await store.isTeamMember(team.id, alice.userId)).toBe(true);
      expect(await store.isTeamMember(team.id, bob.userId)).toBe(false);

      const account = await store.findAccountByEmail("bob@example.test");
      expect(account).toMatchObject({ userId: bob.userId, tenantId: bob.tenantId });
      await store.addTeamMember(team.id, account!);
      expect(await store.isTeamMember(team.id, bob.userId)).toBe(true);

      const bobSession = structuredClone(DEMO_SESSION);
      bobSession.id = "0191cafe-0000-7000-8000-0000000c0009";
      bobSession.visibility = { scope: "team", ownerId: bob.userId, teamId: team.id };
      await store.saveSession(bob, bobSession);
      const visible = await store.listTeamSessions(team.id);
      expect(visible.map((session) => session.id)).toContain(bobSession.id);

      expect(await store.removeTeamMember(team.id, bob.userId)).toBe(true);
      expect(await store.removeTeamMember(team.id, bob.userId)).toBe(false);
    });

    it("queues, replays, and acknowledges machine commands", async () => {
      const store = implementation.create();
      const machineId = "0191cafe-0000-7000-8000-0000000c000a";
      await store.saveMachine(alice, {
        id: machineId, tenantId: alice.tenantId, name: `contract-${implementation.name}`,
        platform: "darwin", agentVersion: null, sourceSettings: {}, lastSeenAt: null,
      });

      const command = await store.createMachineCommand(alice, { machineId, kind: "materialize", payload: { jobId: "job-1" } });
      expect(command.status).toBe("pending");
      expect((await store.listUnackedMachineCommands(alice, machineId)).map((item) => item.status)).toEqual(["pending"]);

      await store.markMachineCommandsDelivered(alice, [command.id]);
      const delivered = await store.listUnackedMachineCommands(alice, machineId);
      expect(delivered[0]!.status).toBe("delivered");
      expect(delivered[0]!.deliveredAt).not.toBeNull();

      expect(await store.ackMachineCommand(alice, machineId, command.id, { status: "failed", error: "disk full" })).toBe(true);
      expect(await store.listUnackedMachineCommands(alice, machineId)).toHaveLength(0);
      expect(await store.ackMachineCommand(alice, machineId, "0191cafe-0000-7000-8000-00000000dead", { status: "completed" })).toBe(false);
    });

    it("looks up share grants by token hash across tenants", async () => {
      const store = implementation.create();
      const session = structuredClone(DEMO_SESSION);
      session.id = "0191cafe-0000-7000-8000-0000000c000b";
      await store.saveSession(alice, session);
      const grant = {
        id: "0191cafe-0000-7000-8000-0000000c000c", tenantId: alice.tenantId, sessionId: session.id,
        permission: "importer" as const, tokenHash: `hash-${implementation.name}`, status: "active" as const,
        createdAt: new Date().toISOString(), expiresAt: null,
      };
      await store.saveShareGrant(alice, grant);

      const lookup = await store.getShareGrantByTokenHash(grant.tokenHash);
      expect(lookup).toMatchObject({ grantId: grant.id, tenantId: alice.tenantId, permission: "importer", status: "active" });
      expect(await store.getShareGrantByTokenHash("no-such-hash")).toBeNull();

      await store.saveShareGrant(alice, { ...grant, status: "revoked" });
      expect((await store.getShareGrantByTokenHash(grant.tokenHash))!.status).toBe("revoked");
    });
  });
}
