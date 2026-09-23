import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchiveStore, MachineRecord, TenantContext } from "../src/archive-store.js";
import { CredentialsService } from "../src/auth/credentials.service.js";
import { TokenService } from "../src/auth/tokens.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { AuthIdentityEntity, MachineTokenEntity } from "../src/entities.js";
import { uuidV7 } from "../src/ids.js";
import { MachineRevocationService } from "../src/machine-revocation.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { TEST_CONTEXT } from "./fixtures/archive.js";
import { dockerAvailable, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

/**
 * Retirement and token revocation against both stores.
 *
 * The HTTP suite runs on the in-memory store with no database, so the half
 * production runs (the `retiredAt` column, its partial unique index, and the
 * two tables a revocation writes) is proven here. Kept out of
 * `store-contract.test.ts`, which is already past 700 lines, but built the same
 * way: one set of expectations, run against each implementation.
 */
const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const FIXTURE = { container: "memoar-machine-revocation-test", port: 55990 };

const alice: TenantContext = TEST_CONTEXT;
const bob: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000b1", userId: "0191cafe-0000-7000-8000-0000000000b2", scopes: ["*"], authType: "dev",
};

let dataSource: DataSource | null = null;

beforeAll(async () => {
  if (!usePostgres) return;
  dataSource = await startPostgres(FIXTURE);
  await seedAccount(dataSource, { userId: alice.userId, tenantId: alice.tenantId, email: "alice@example.test" });
  await seedAccount(dataSource, { userId: bob.userId, tenantId: bob.tenantId, email: "bob@example.test" });
}, 300_000);

afterAll(async () => { await stopPostgres(dataSource, FIXTURE); });

function machine(context: TenantContext, installationId: string | null = null): MachineRecord {
  return {
    id: uuidV7(), tenantId: context.tenantId, name: "laptop", platform: "macos", agentVersion: null,
    sourceSettings: {}, lastSeenAt: null, installationId,
  };
}

const implementations: { name: string; skip: boolean; create: () => ArchiveStore; database: () => DataSource | null }[] = [
  { name: "memory", skip: false, create: () => new DevArchiveStore(), database: () => null },
  { name: "postgres", skip: !usePostgres, create: () => new PostgresArchiveStore(dataSource!), database: () => dataSource },
];

for (const implementation of implementations) {
  const suite = implementation.skip ? describe.skip : describe;

  suite(`retiring a machine: ${implementation.name}`, () => {
    it("hides it from every live read, once, and only in its own tenant", async () => {
      const store = implementation.create();
      const retired = machine(alice, `install-${uuidV7()}`);
      const kept = machine(alice);
      await store.saveMachine(alice, retired);
      await store.saveMachine(alice, kept);

      expect(await store.retireMachine(bob, retired.id), "another tenant retired it").toBe(false);
      expect(await store.getMachine(alice, retired.id)).not.toBeNull();

      expect(await store.retireMachine(alice, retired.id)).toBe(true);
      expect(await store.retireMachine(alice, retired.id), "retired twice").toBe(false);
      expect(await store.getMachine(alice, retired.id)).toBeNull();
      expect(await store.findMachineByInstallation(alice, retired.installationId!)).toBeNull();
      const listed = (await store.listMachines(alice)).map((row) => row.id);
      expect(listed).not.toContain(retired.id);
      expect(listed).toContain(kept.id);
    });

    it("is not undone by a stale record saved afterwards", async () => {
      // A heartbeat reads the machine, a deregistration lands, the heartbeat
      // saves what it read. The machine must stay retired.
      const store = implementation.create();
      const record = machine(alice);
      await store.saveMachine(alice, record);
      const stale = await store.getMachine(alice, record.id);

      await store.retireMachine(alice, record.id);
      await store.saveMachine(alice, { ...stale!, lastSeenAt: new Date().toISOString() });

      expect(await store.getMachine(alice, record.id)).toBeNull();
    });

    it("frees its installation id for a new enrolment", async () => {
      const store = implementation.create();
      const installationId = `install-${uuidV7()}`;
      const first = machine(alice, installationId);
      await store.saveMachine(alice, first);
      await store.retireMachine(alice, first.id);

      const second = machine(alice, installationId);
      await store.saveMachine(alice, second);

      expect((await store.findMachineByInstallation(alice, installationId))?.id).toBe(second.id);
    });
  });

  suite(`revoking machine tokens: ${implementation.name}`, () => {
    async function setup() {
      const tokens = new TokenService();
      const store = implementation.create();
      const credentials = new CredentialsService(tokens, implementation.database(), store);
      const leaked = machine(alice);
      const other = machine(alice);
      await store.saveMachine(alice, leaked);
      await store.saveMachine(alice, other);
      const live = async (token: string) => credentials.machineTokenLive(token, tokens.verify(token)!);
      return { credentials, store, leaked, other, live };
    }

    it("revokes every live token of one machine and no other", async () => {
      const { credentials, leaked, other, live } = await setup();
      const first = (await credentials.issueMachineToken(alice, leaked.id)).token;
      const second = (await credentials.issueMachineToken(alice, leaked.id)).token;
      const bystander = (await credentials.issueMachineToken(alice, other.id)).token;

      expect(await credentials.revokeMachineTokens(bob, leaked.id), "another tenant revoked them").toBe(0);
      expect(await live(first)).toBe(true);

      expect(await credentials.revokeMachineTokens(alice, leaked.id)).toBe(2);

      expect(await live(first)).toBe(false);
      expect(await live(second)).toBe(false);
      expect(await credentials.machineTokenRevoked(first)).toBe(true);
      expect(await live(bystander), "revoking one machine took another's token").toBe(true);
      expect(await credentials.machineTokenRevoked(bystander)).toBe(false);
      expect(await credentials.revokeMachineTokens(alice, leaked.id), "nothing left to revoke").toBe(0);
    });

    it("is part of deregistering, not only a side effect of the machine going", async () => {
      // A retired machine's token is refused anyway, because authentication
      // also asks for a live machine. The identity is revoked in its own right
      // so nothing that reads it, now or later, finds the token live.
      const { credentials, leaked, store } = await setup();
      const token = (await credentials.issueMachineToken(alice, leaked.id)).token;

      await new MachineRevocationService(store, credentials).deregister(alice, leaked.id);

      expect(await credentials.machineTokenRevoked(token)).toBe(true);
      expect(await store.getMachine(alice, leaked.id)).toBeNull();
    });

    it("keeps the per-machine ledger in step with the identities", async () => {
      const database = implementation.database();
      if (!database) return;
      const { credentials, leaked, other } = await setup();
      await credentials.issueMachineToken(alice, leaked.id);
      await credentials.issueMachineToken(alice, other.id);

      await credentials.revokeMachineTokens(alice, leaked.id);

      const ledger = await database.getRepository(MachineTokenEntity).findBy({ machineId: leaked.id });
      const identities = await database.getRepository(AuthIdentityEntity).findBy({ kind: "machine_token", machineId: leaked.id });
      expect(ledger.map((row) => row.revokedAt !== null)).toEqual([true]);
      expect(identities.map((row) => row.revokedAt !== null)).toEqual([true]);
      const untouched = await database.getRepository(MachineTokenEntity).findBy({ machineId: other.id });
      expect(untouched.map((row) => row.revokedAt)).toEqual([null]);
    });
  });
}
