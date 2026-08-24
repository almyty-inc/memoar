import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_CONTEXT, DEMO_SESSION } from "../src/demo-data.js";
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
  await seedAccount(owner, { userId: DEMO_CONTEXT.userId, tenantId: DEMO_CONTEXT.tenantId, email: "rls@example.test" });
  await new PostgresArchiveStore(owner).saveSession(DEMO_CONTEXT, DEMO_SESSION);
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

  it("hides rows from a connection scoped to a different tenant", async () => {
    await appRole!.query(`SELECT set_config('memoar.tenant_id', $1, false)`, [OTHER_TENANT]);
    expect(await countRows(appRole!, "sessions")).toBe(0);
    expect(await countRows(appRole!, "turns")).toBe(0);
    expect(await countRows(appRole!, "content_blocks")).toBe(0);
  });

  it("reveals rows only for the owning tenant", async () => {
    await appRole!.query(`SELECT set_config('memoar.tenant_id', $1, false)`, [DEMO_CONTEXT.tenantId]);
    expect(await countRows(appRole!, "sessions")).toBeGreaterThan(0);
  });

  it("hides every row when no tenant is set, rather than falling open", async () => {
    await appRole!.query(`SELECT set_config('memoar.tenant_id', '', false)`);
    expect(await countRows(appRole!, "sessions")).toBe(0);
  });

  it("refuses writes that claim another tenant", async () => {
    await appRole!.query(`SELECT set_config('memoar.tenant_id', $1, false)`, [DEMO_CONTEXT.tenantId]);
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
