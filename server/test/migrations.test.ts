import { execFileSync } from "node:child_process";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/data-source.js";
import { ENTITIES } from "../src/entities.js";
import { connectWithRetry, dockerAvailable, queryRows } from "./helpers/postgres.js";

const CONTAINER = "memoar-migrations-test";
const PORT = 55981;
const OWNER_URL = `postgres://memoar:migrations@127.0.0.1:${PORT}/memoar`;
const APP_URL = `postgres://memoar_app:memoar_app@127.0.0.1:${PORT}/memoar`;

/** Tables whose tenant policies must be forced, not merely enabled. */
const FORCED_RLS_TABLES = [
  "sessions", "turns", "content_blocks", "raw_artifacts",
  "session_identities", "share_grants", "machine_commands",
];

const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;

let owner: DataSource | null = null;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

beforeAll(async () => {
  if (!usePostgres) return;
  try { docker("rm", "-f", CONTAINER); } catch { /* not running */ }
  docker(
    "run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_DB=memoar", "-e", "POSTGRES_USER=memoar", "-e", "POSTGRES_PASSWORD=migrations",
    "-p", `${PORT}:5432`, "pgvector/pgvector:pg16",
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker("exec", CONTAINER, "pg_isready", "-U", "memoar");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  owner = new DataSource({
    type: "postgres", url: OWNER_URL, entities: [...ENTITIES],
    migrations: MIGRATIONS, synchronize: false, migrationsRun: false,
  });
  // Shares the readiness retry: pg_isready passes while the image is still
  // initialising and about to restart, so a first connection can be reset.
  await connectWithRetry(owner, { container: CONTAINER, port: PORT });
}, 180_000);

afterAll(async () => {
  if (owner?.isInitialized) await owner.destroy();
  try { docker("rm", "-f", CONTAINER); } catch { /* already gone */ }
});

/**
 * Schema evolution proof against a real Postgres: every migration must apply,
 * revert, and re-apply on an empty database, and the tenant policies must
 * actually filter for the runtime role afterwards.
 */
suite("migrations", () => {
  it("applies every registered migration to an empty database", async () => {
    const applied = await owner!.runMigrations({ transaction: "all" });
    expect(applied.length).toBe(MIGRATIONS.length);
  }, 120_000);

  it("reverts every migration without leaving tables behind", async () => {
    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      await owner!.undoLastMigration({ transaction: "all" });
    }
    const remaining = await queryRows<{ tablename: string }>(
      owner!,
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'",
    );
    expect(remaining.map((row) => row.tablename)).toEqual([]);
  }, 120_000);

  it("re-applies cleanly after a full revert", async () => {
    const reapplied = await owner!.runMigrations({ transaction: "all" });
    expect(reapplied.length).toBe(MIGRATIONS.length);
  }, 120_000);

  it.each(FORCED_RLS_TABLES)("forces row level security on %s", async (table) => {
    const rows = await queryRows<{ relforcerowsecurity: boolean }>(
      owner!,
      "SELECT relforcerowsecurity FROM pg_class WHERE relname = $1",
      [table],
    );
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("enforces those policies for the runtime role, not just in the catalog", async () => {
    const appRole = new DataSource({ type: "postgres", url: APP_URL, entities: [], synchronize: false });
    await connectWithRetry(appRole, { container: CONTAINER, port: PORT });
    try {
      const role = await queryRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
        appRole,
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      await appRole.query("SELECT set_config('memoar.tenant_id', $1, false)", ["0191cafe-0000-7000-8000-0000000000f1"]);
      await appRole.query(
        `INSERT INTO sessions (id, "tenantId", source, workspace, "capturedCreatedAt", "capturedUpdatedAt", title, models, "tokenTotals", provenance, visibility, "searchDocument")
         VALUES (gen_random_uuid(), $1, '{}', '{}', now(), now(), 'rls probe', '{}', '{}', '[]', '{}', '')`,
        ["0191cafe-0000-7000-8000-0000000000f1"],
      );
      await appRole.query("SELECT set_config('memoar.tenant_id', $1, false)", ["0191cafe-0000-7000-8000-0000000000f2"]);
      const leaked = await queryRows<{ count: number }>(appRole, "SELECT count(*)::int AS count FROM sessions");
      expect(leaked[0]?.count).toBe(0);
    } finally {
      await appRole.destroy();
    }
  }, 60_000);
});
