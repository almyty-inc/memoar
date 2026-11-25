import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/data-source.js";
import { runMigrations } from "../src/migrate.js";
import { runtimeRole } from "../src/main.js";
import { assertTenantIsolationEnforced } from "../src/startup-checks.js";
import { ENTITIES } from "../src/entities.js";
import { docker } from "./helpers/docker.js";
import {
  appRoleUrl, connectWithRetry, dockerAvailable, migrationRoleUrl, PostgresFixture, prepareMigrationRole, queryRows,
} from "./helpers/postgres.js";

const FIXTURE = new PostgresFixture("memoar-migrations-test");

/** Tables whose tenant policies must be forced, not merely enabled. */
const FORCED_RLS_TABLES = [
  "sessions", "turns", "content_blocks", "raw_artifacts",
  "session_identities", "share_grants", "machine_commands",
];

const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;

let owner: DataSource | null = null;
let migrator: DataSource | null = null;

beforeAll(async () => {
  if (!usePostgres) return;
  FIXTURE.start({ password: "migrations" });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker("exec", FIXTURE.container, "pg_isready", "-U", "memoar");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  owner = new DataSource({
    type: "postgres", url: FIXTURE.url("memoar", "migrations"), entities: [...ENTITIES],
    migrations: MIGRATIONS, synchronize: false, migrationsRun: false,
  });
  // Shares the readiness retry: pg_isready passes while the image is still
  // initialising and about to restart, so a first connection can be reset.
  await connectWithRetry(owner, FIXTURE);
  // The cluster runs migrations as a schema owner that is neither a superuser
  // nor BYPASSRLS. Run as the superuser, they passed here while a probe and a
  // repair did nothing under row-level security in the deployment.
  prepareMigrationRole(FIXTURE.container);
  if (migrator?.isInitialized) await migrator.destroy();
  migrator = new DataSource({
    type: "postgres", url: migrationRoleUrl(FIXTURE), entities: [...ENTITIES],
    migrations: MIGRATIONS, synchronize: false, migrationsRun: false,
  });
  await connectWithRetry(migrator, FIXTURE);
}, 180_000);

afterAll(async () => {
  if (owner?.isInitialized) await owner.destroy();
  FIXTURE.remove();
});

/**
 * Schema evolution proof against a real Postgres: every migration must apply,
 * revert, and re-apply on an empty database, and the tenant policies must
 * actually filter for the runtime role afterwards.
 */
suite("migrations", () => {
  it("applies every registered migration to an empty database", async () => {
    const applied = await migrator!.runMigrations({ transaction: "all" });
    expect(applied.length).toBe(MIGRATIONS.length);
  }, 120_000);

  it("reverts every migration without leaving tables behind", async () => {
    for (let index = 0; index < MIGRATIONS.length; index += 1) {
      await migrator!.undoLastMigration({ transaction: "all" });
    }
    const remaining = await queryRows<{ tablename: string }>(
      owner!,
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'",
    );
    expect(remaining.map((row) => row.tablename)).toEqual([]);
  }, 120_000);

  it("re-applies cleanly after a full revert", async () => {
    const reapplied = await migrator!.runMigrations({ transaction: "all" });
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
    const appRole = new DataSource({ type: "postgres", url: appRoleUrl(FIXTURE), entities: [], synchronize: false });
    await connectWithRetry(appRole, FIXTURE);
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

  it("refuses to boot against the owner connection and accepts the runtime one", async () => {
    // The check the API runs at startup, against both real roles. Nothing used
    // to ask, so an operator who put the owner URL in DATABASE_URL disabled
    // every tenant policy and the archive behaved exactly as before.
    await expect(assertTenantIsolationEnforced(() => runtimeRole(owner!)))
      .rejects.toThrow(/bypasses every FORCE ROW LEVEL SECURITY policy/u);

    const appRole = new DataSource({ type: "postgres", url: appRoleUrl(FIXTURE), entities: [], synchronize: false });
    await connectWithRetry(appRole, FIXTURE);
    try {
      await expect(assertTenantIsolationEnforced(() => runtimeRole(appRole))).resolves.toBeUndefined();
    } finally {
      await appRole.destroy();
    }
  }, 60_000);

  /**
   * The entrypoint the deploy runs before it rolls any pod.
   *
   * The API can migrate on boot, which is right for one process and wrong for
   * several: a rollout starts replicas together and they race the same DDL. So
   * a deployment runs this first, waits, and aborts if it fails — which means
   * this is the code standing between a schema and every pod that serves it.
   */
  it("migrates a fresh database from the command the deploy job runs", async () => {
    const fixture = new PostgresFixture("memoar-migrate-entrypoint-test");
    const { container } = fixture;
    fixture.start({ password: "migrate" });
    try {
      /*
        `pg_isready` is not a readiness probe for this.

        The image's entrypoint runs initdb against a temporary server on a unix
        socket, then stops it and starts the real one. `pg_isready` answers yes
        during that window, so the very next command raced the restart and the
        job failed at `CREATE EXTENSION` — intermittently, which is worse than
        always. A query that has to be served is the thing to wait on.
      */
      let ready = false;
      for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
        try {
          docker("exec", container, "psql", "-U", "memoar", "-d", "memoar", "-tAc", "select 1");
          ready = true;
        } catch {
          await new Promise((done) => setTimeout(done, 1000));
        }
      }
      if (!ready) throw new Error(`${container} never accepted a query`);

      // The extensions and the migration role, as the cluster has them: the
      // extensions take a superuser, and the migration role owns the schema and
      // is deliberately not one.
      prepareMigrationRole(container);

      const previousUrl = process.env.MIGRATION_DATABASE_URL;
      const previousPassword = process.env.MEMOAR_APP_DB_PASSWORD;
      process.env.MIGRATION_DATABASE_URL = migrationRoleUrl(fixture);
      process.env.MEMOAR_APP_DB_PASSWORD = "a-runtime-password-of-real-length";
      try {
        await runMigrations();
        // Run twice: the deploy applies this Job on every rollout, so a second
        // run against an already-migrated database has to be a no-op rather
        // than an error that aborts a deploy of an unchanged schema.
        await runMigrations();
      } finally {
        if (previousUrl === undefined) delete process.env.MIGRATION_DATABASE_URL;
        else process.env.MIGRATION_DATABASE_URL = previousUrl;
        if (previousPassword === undefined) delete process.env.MEMOAR_APP_DB_PASSWORD;
        else process.env.MEMOAR_APP_DB_PASSWORD = previousPassword;
      }

      const migrated = new DataSource({ type: "postgres", url: fixture.url("memoar", "migrate"), entities: [...ENTITIES] });
      await connectWithRetry(migrated, fixture);
      try {
        const applied = await queryRows<{ count: number }>(migrated, "SELECT count(*)::int AS count FROM migrations");
        expect(applied[0]?.count).toBe(MIGRATIONS.length);
        // The least-privilege runtime role the API connects as is created by a
        // migration, so the API cannot start before this has run.
        const role = await queryRows<{ rolname: string }>(migrated, "SELECT rolname FROM pg_roles WHERE rolname = 'memoar_app'");
        expect(role, "the runtime role the API signs in as").toHaveLength(1);
      } finally {
        await migrated.destroy();
      }
    } finally {
      fixture.remove();
    }
  }, 300_000);

  it("refuses to migrate without being told which database", async () => {
    const previous = { url: process.env.MIGRATION_DATABASE_URL, fallback: process.env.DATABASE_URL };
    delete process.env.MIGRATION_DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(runMigrations()).rejects.toThrow(/MIGRATION_DATABASE_URL is required/u);
    } finally {
      if (previous.url !== undefined) process.env.MIGRATION_DATABASE_URL = previous.url;
      if (previous.fallback !== undefined) process.env.DATABASE_URL = previous.fallback;
    }
  });
});
