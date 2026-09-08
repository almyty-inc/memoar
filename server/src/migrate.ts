import "reflect-metadata";
import { DataSource } from "typeorm";
import { ENTITIES } from "./entities.js";
import { MIGRATIONS } from "./data-source.js";
import { logLine } from "./observability.js";

/**
 * Runs the migrations, once, and exits.
 *
 * The API applies migrations on boot, which is right for one process and wrong
 * for several: a rollout starts replicas at the same moment and they race each
 * other through the same DDL. So a deployment runs this first as its own job,
 * waits for it, and only then rolls the pods — and a failed migration stops the
 * deploy instead of producing pods that half-work against a half-migrated
 * schema.
 *
 * Takes MIGRATION_DATABASE_URL, not DATABASE_URL. DDL needs an owner; the
 * runtime role must not be one, because a superuser silently bypasses every
 * row-level security policy in the archive.
 */
export async function runMigrations(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required to migrate");

  const dataSource = new DataSource({
    type: "postgres",
    url,
    entities: [...ENTITIES],
    migrations: MIGRATIONS,
    synchronize: false,
    migrationsRun: false,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false,
  });

  await dataSource.initialize();
  try {
    // One transaction for the lot: a migration that fails halfway leaves the
    // schema as it was rather than somewhere between two versions.
    const applied = await dataSource.runMigrations({ transaction: "all" });
    logLine({
      level: "info",
      event: "migrations_applied",
      count: applied.length,
      names: applied.map((migration) => migration.name),
    });
  } finally {
    await dataSource.destroy();
  }
}

// Only when run as a program, so a test can import the function without it
// migrating something on import.
if (process.argv[1]?.endsWith("migrate.js") || process.argv[1]?.endsWith("migrate.ts")) {
  runMigrations().catch((error: unknown) => {
    logLine({ level: "error", event: "migrations_failed", message: error instanceof Error ? error.message : String(error) });
    // Non-zero, so the Job fails and the deploy stops rather than rolling pods
    // out against a schema that was never migrated.
    process.exit(1);
  });
}
