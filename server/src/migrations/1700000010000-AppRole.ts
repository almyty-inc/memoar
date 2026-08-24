import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the least-privilege role the API and worker connect as.
 *
 * FORCE ROW LEVEL SECURITY does not apply to superusers or to roles with
 * BYPASSRLS, so connecting as the bootstrap superuser silently disables every
 * tenant policy. The runtime role below owns nothing and holds only DML, so the
 * policies actually filter.
 */
export class AppRole1700000010000 implements MigrationInterface {
  name = "AppRole1700000010000";

  async up(queryRunner: QueryRunner): Promise<void> {
    const password = process.env.MEMOAR_APP_DB_PASSWORD ?? "memoar_app";
    const database = (await queryRunner.query("SELECT current_database() AS name") as { name: string }[])[0]!.name;
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memoar_app') THEN
          CREATE ROLE memoar_app LOGIN PASSWORD ${quote(password)};
        ELSE
          ALTER ROLE memoar_app LOGIN PASSWORD ${quote(password)};
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`ALTER ROLE memoar_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await queryRunner.query(`GRANT CONNECT ON DATABASE "${database}" TO memoar_app`);
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO memoar_app`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO memoar_app`);
    await queryRunner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO memoar_app`);
    // Tables added by later migrations inherit the same grants.
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO memoar_app`);
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO memoar_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const database = (await queryRunner.query("SELECT current_database() AS name") as { name: string }[])[0]!.name;
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM memoar_app`);
    await queryRunner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM memoar_app`);
    await queryRunner.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM memoar_app`);
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM memoar_app`);
    await queryRunner.query(`REVOKE USAGE ON SCHEMA public FROM memoar_app`);
    await queryRunner.query(`REVOKE CONNECT ON DATABASE "${database}" FROM memoar_app`);
    await queryRunner.query(`DROP ROLE IF EXISTS memoar_app`);
  }
}

/** Postgres literal quoting for a password that never goes through a bind parameter (roles cannot be parameterized). */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
