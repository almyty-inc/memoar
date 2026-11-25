import { Client } from "pg";
import { DataSource } from "typeorm";
import { ENTITIES } from "../../src/entities.js";
import { MIGRATIONS } from "../../src/data-source.js";
import { docker, PostgresFixture } from "./docker.js";

export { dockerAvailable, PostgresFixture } from "./docker.js";

/**
 * Each suite gets its own container, and Docker picks each one's host port,
 * so files can run in parallel without coordinating port numbers.
 */
export const CONTRACT_FIXTURE = new PostgresFixture("memoar-store-contract-test");
export const RLS_FIXTURE = new PostgresFixture("memoar-rls-test");
/** Two teams, four tenants: the cross-workspace isolation proof runs alone. */
export const TEAM_FANOUT_FIXTURE = new PostgresFixture("memoar-team-fanout-test");

/** The superuser password the shared helper starts every container with. */
const SUPERUSER_PASSWORD = "contract";

/** The container's superuser, for seeding and for inspecting every tenant. */
export function superuserUrl(fixture: PostgresFixture): string {
  return fixture.url("memoar", SUPERUSER_PASSWORD);
}

/** Least-privilege runtime role created by the AppRole migration. */
export function appRoleUrl(fixture: PostgresFixture): string {
  return fixture.url("memoar_app", "memoar_app");
}

export { MIGRATIONS } from "../../src/data-source.js";

/**
 * Starts a throwaway pgvector container and applies every migration, so the
 * Postgres store is exercised against the same schema production runs. Never
 * touches the long-lived e2e volume.
 *
 * The migrations run as the cluster's migration role (see
 * `prepareMigrationRole`), not as the container's superuser. Run as the
 * superuser, they passed while doing nothing under row-level security in the
 * deployment. The DataSource returned is still the superuser's, for seeding
 * and for inspecting every tenant's rows.
 */
export async function startPostgres(fixture: PostgresFixture = CONTRACT_FIXTURE): Promise<DataSource> {
  fixture.start({ password: SUPERUSER_PASSWORD });
  // pg_isready passes while the image's entrypoint still has Postgres up for
  // initialization, and the server is restarted immediately afterwards. A
  // connection opened in that window is reset, which showed up as suites that
  // passed alone and failed when several containers started at once. Readiness
  // is therefore a connection that survives, not a single probe.
  await waitForStablePostgres(superuserUrl(fixture));
  prepareMigrationRole(fixture.container);
  const migrator = new DataSource({
    type: "postgres", url: migrationRoleUrl(fixture), entities: [...ENTITIES],
    migrations: MIGRATIONS, synchronize: false, migrationsRun: false,
  });
  await connectWithRetry(migrator, fixture);
  try {
    await migrator.runMigrations({ transaction: "all" });
  } finally {
    await migrator.destroy();
  }
  const dataSource = new DataSource({
    type: "postgres",
    url: superuserUrl(fixture),
    entities: [...ENTITIES],
    migrations: MIGRATIONS,
    synchronize: false,
    migrationsRun: false,
  });
  await connectWithRetry(dataSource, fixture);
  return dataSource;
}

/** The role migrations run as in the cluster. */
export const MIGRATION_ROLE = { name: "memoar_owner", password: "migration-role" };

export function migrationRoleUrl(fixture: PostgresFixture): string {
  return fixture.url(MIGRATION_ROLE.name, MIGRATION_ROLE.password);
}

/**
 * Sets a fresh container up the way the cluster is.
 *
 * The superuser creates the extensions, as deploy/init.sql and the infra
 * ConfigMap do, and a migration role that owns the database and its schema,
 * may create roles (the AppRole migration creates memoar_app), and is neither a
 * superuser nor BYPASSRLS. Every table FORCEs row-level security, so this role
 * is filtered by the tenant policies like any other.
 */
export function prepareMigrationRole(container: string): void {
  docker("exec", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "memoar", "-d", "memoar", "-c", `
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE ROLE ${MIGRATION_ROLE.name} LOGIN PASSWORD '${MIGRATION_ROLE.password}' NOSUPERUSER NOBYPASSRLS CREATEROLE;
    ALTER DATABASE memoar OWNER TO ${MIGRATION_ROLE.name};
    ALTER SCHEMA public OWNER TO ${MIGRATION_ROLE.name};
  `);
}

/**
 * Waits for a Postgres that will still be there a moment later.
 *
 * pg_isready answers while the image's entrypoint still has a temporary server
 * up for initialisation, and that server is shut down immediately afterwards.
 * Anything that connects in the gap gets "Connection terminated unexpectedly" —
 * which is how a benchmark that boots the app straight after the probe failed
 * in CI while passing locally. Two consecutive round trips, a beat apart, means
 * the real server is answering.
 */
export async function waitForStablePostgres(url: string, attempts = 60): Promise<void> {
  let consecutive = 0;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      consecutive += 1;
      if (consecutive >= 2) return;
    } catch (error) {
      lastError = error;
      consecutive = 0;
    } finally {
      await client.end().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`postgres at ${url} never settled: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function connectWithRetry(dataSource: DataSource, fixture: PostgresFixture): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await dataSource.initialize();
      return;
    } catch (error) {
      lastError = error;
      if (dataSource.isInitialized) await dataSource.destroy().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`${fixture.container} never accepted a stable connection: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function stopPostgres(dataSource: DataSource | null, fixture: PostgresFixture = CONTRACT_FIXTURE): Promise<void> {
  if (dataSource?.isInitialized) await dataSource.destroy();
  fixture.remove();
}

/** Seeds the users and auth identities the store's directory lookups depend on. */
export async function seedAccount(
  dataSource: DataSource,
  account: { userId: string; tenantId: string; email: string },
): Promise<void> {
  await dataSource.query(
    `INSERT INTO users (id, email, "displayName") VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
    [account.userId, account.email, account.email],
  );
  await dataSource.query(
    `INSERT INTO auth_identities (id, kind, "lookupKey", "tenantId", "userId", "secretHash", scopes)
     VALUES (gen_random_uuid(), 'password', $1, $2, $3, 'x', ARRAY['archive:read'])
     ON CONFLICT (kind, "lookupKey") DO NOTHING`,
    [account.email, account.tenantId, account.userId],
  );
}

/** Typed wrapper around DataSource.query, whose return type is `any`. */
export async function queryRows<T>(dataSource: DataSource, sql: string, parameters: unknown[] = []): Promise<T[]> {
  const rows: unknown = await dataSource.query(sql, parameters);
  return rows as T[];
}

/** Reads a single `count(*)::int AS count` result. */
export async function countRows(dataSource: DataSource, table: string): Promise<number> {
  const rows = await queryRows<{ count: number }>(dataSource, `SELECT count(*)::int AS count FROM ${table}`);
  return rows[0]?.count ?? -1;
}