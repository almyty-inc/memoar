import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { appRoleUrl, countRows, dockerAvailable, queryRows, RLS_FIXTURE, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;

let owner: DataSource | null = null;
let appRole: DataSource | null = null;

const OTHER_TENANT = "0191cafe-0000-7000-8000-0000000000f1";

beforeAll(async () => {
  if (!usePostgres) return;
  owner = await startPostgres(RLS_FIXTURE);
  await seedAccount(owner, { userId: TEST_CONTEXT.userId, tenantId: TEST_CONTEXT.tenantId, email: "rls@example.test" });
  await new PostgresArchiveStore(owner).saveSession(TEST_CONTEXT, TEST_SESSION);
  appRole = new DataSource({ type: "postgres", url: appRoleUrl(RLS_FIXTURE), entities: [], synchronize: false });
  await appRole.initialize();
}, 180_000);

afterAll(async () => {
  if (appRole?.isInitialized) await appRole.destroy();
  await stopPostgres(owner, RLS_FIXTURE);
});

/**
 * Row Level Security is only a real boundary when the connecting role is not a
 * superuser and does not hold BYPASSRLS. Asserting the catalog flags
 * (relrowsecurity / relforcerowsecurity) proves nothing about enforcement,
 * which is how a superuser runtime connection stayed undetected. These cases
 * assert observed filtering through the actual runtime role.
 */
suite("row level security is enforced for the runtime role", () => {
  it("runs as a role that can neither bypass RLS nor escalate", async () => {
    const rows = await queryRows<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      appRole!,
      "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
  });

  /**
   * Tables that carry a tenantId and are nonetheless looked up without one.
   *
   * Each is reached by a key the caller must already possess, before any tenant
   * is known — which is precisely why a tenant-scoped policy cannot apply to
   * them. Anything not on this list is a mistake, so the list is short and every
   * entry says why it is here.
   */
  const CROSS_TENANT_LOOKUPS: Record<string, string> = {
    // Signing in finds the identity by email and verifies the password; which
    // tenant it belongs to is the answer, so it cannot also be the question.
    auth_identities: "login resolves the tenant from the credential",
    // A share is redeemed by somebody in another tenant. The key is the hash of
    // a token they were given; scoping the row to the issuing tenant would mean
    // nobody could ever accept one.
    share_tokens: "a recipient in a different tenant redeems by token hash",
    // Which tenants a user belongs to has to be answerable before one is chosen.
    team_members: "membership is resolved by user id before a tenant is picked",
  };

  it("protects every table that carries a tenant, not just the ones named here", async () => {
    // These cases used to name their tables one at a time, so a table added
    // later — memory documents, say — could be created without a policy and
    // nothing would notice: it would simply be readable by every tenant. The
    // rule is mechanical, so assert it mechanically.
    const unprotected = await queryRows<{ table: string; enabled: boolean; forced: boolean; policies: string }>(
      appRole!,
      `SELECT c.relname AS "table", c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN information_schema.columns col
           ON col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenantId'
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
               OR (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) = 0)`,
    );
    const unexplained = unprotected.filter((row) => !(row.table in CROSS_TENANT_LOOKUPS));
    expect(unexplained, "these tables hold a tenantId and are readable by any tenant").toEqual([]);
    // And the exemptions must still exist: a stale name here would quietly
    // excuse a table that has since been renamed into something unprotected.
    const names = new Set(unprotected.map((row) => row.table));
    expect(Object.keys(CROSS_TENANT_LOOKUPS).filter((table) => !names.has(table)), "these exemptions are no longer needed").toEqual([]);
  });

  it("hides rows from a connection scoped to a different tenant", async () => {
    await appRole!.query(`SELECT set_config('memoar.tenant_id', $1, false)`, [OTHER_TENANT]);
    expect(await countRows(appRole!, "sessions")).toBe(0);
    expect(await countRows(appRole!, "turns")).toBe(0);
    expect(await countRows(appRole!, "content_blocks")).toBe(0);
  });

  it("reveals rows only for the owning tenant", async () => {
    await appRole!.query(`SELECT set_config('memoar.tenant_id', $1, false)`, [TEST_CONTEXT.tenantId]);
    expect(await countRows(appRole!, "sessions")).toBeGreaterThan(0);
  });

  it("hides every row when no tenant is set, rather than falling open", async () => {
    await appRole!.query(`SELECT set_config('memoar.tenant_id', '', false)`);
    expect(await countRows(appRole!, "sessions")).toBe(0);
  });

  it("refuses writes that claim another tenant", async () => {
    await appRole!.query(`SELECT set_config('memoar.tenant_id', $1, false)`, [TEST_CONTEXT.tenantId]);
    await expect(appRole!.query(
      `INSERT INTO sessions (id, "tenantId", source, workspace, "capturedCreatedAt", "capturedUpdatedAt", title, models, "tokenTotals", provenance, visibility, "searchDocument")
       VALUES (gen_random_uuid(), $1, '{}', '{}', now(), now(), 'cross tenant write', '{}', '{}', '[]', '{}', '')`,
      [OTHER_TENANT],
    )).rejects.toThrow(/row-level security/i);
  });

  it("cannot perform DDL with the runtime role", async () => {
    await expect(appRole!.query(`CREATE TABLE rls_escalation_check (id uuid)`)).rejects.toThrow();
  });
});
