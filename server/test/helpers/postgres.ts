import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { DataSource } from "typeorm";
import { ENTITIES } from "../../src/entities.js";
import { MIGRATIONS } from "../../src/data-source.js";

/** Each suite gets its own container and port so files can run in parallel. */
export interface PostgresFixture {
  container: string;
  port: number;
}

export const CONTRACT_FIXTURE: PostgresFixture = { container: "memoar-store-contract-test", port: 55979 };
export const RLS_FIXTURE: PostgresFixture = { container: "memoar-rls-test", port: 55980 };

/** Least-privilege runtime role created by the AppRole migration. */
export function appRoleUrl(fixture: PostgresFixture): string {
  return `postgres://memoar_app:memoar_app@127.0.0.1:${fixture.port}/memoar`;
}

export { MIGRATIONS } from "../../src/data-source.js";

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function dockerAvailable(): boolean {
  try {
    docker("info");
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts a throwaway pgvector container and applies every migration, so the
 * Postgres store is exercised against the same schema production runs. Never
 * touches the long-lived e2e volume.
 */
export async function startPostgres(fixture: PostgresFixture = CONTRACT_FIXTURE): Promise<DataSource> {
  try { docker("rm", "-f", fixture.container); } catch { /* not running */ }
  docker(
    "run", "-d", "--name", fixture.container,
    "-e", "POSTGRES_DB=memoar", "-e", "POSTGRES_USER=memoar", "-e", "POSTGRES_PASSWORD=contract",
    "-p", `${fixture.port}:5432`, "pgvector/pgvector:pg16",
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker("exec", fixture.container, "pg_isready", "-U", "memoar");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const dataSource = new DataSource({
    type: "postgres",
    url: `postgres://memoar:contract@127.0.0.1:${fixture.port}/memoar`,
    entities: [...ENTITIES],
    migrations: MIGRATIONS,
    synchronize: false,
    migrationsRun: false,
  });
  // pg_isready passes while the image's entrypoint still has Postgres up for
  // initialization, and the server is restarted immediately afterwards. A
  // connection opened in that window is reset, which showed up as suites that
  // passed alone and failed when several containers started at once. Readiness
  // is therefore a connection that survives, not a single probe.
  await connectWithRetry(dataSource, fixture);
  await dataSource.runMigrations({ transaction: "all" });
  return dataSource;
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
  try { docker("rm", "-f", fixture.container); } catch { /* already gone */ }
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