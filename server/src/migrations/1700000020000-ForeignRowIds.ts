import type { MigrationInterface, QueryRunner } from "typeorm";

/** The role the probe functions run as. It cannot log in and nobody inherits it. */
export const PROBE_ROLE = "memoar_row_id_probe";

/**
 * Lets a save ask whether a turn or block id is held outside its own session,
 * in any account, without seeing the row that holds it.
 *
 * `turns.id` and `content_blocks.id` are primary keys across every account,
 * and a parser keeps a transcript's own uuids. So when a second account
 * uploaded a transcript the first already had, its insert met the first
 * account's row and failed on `turns_pkey`. The save already rescoped an id
 * another session held, but it asked as the runtime role, and row-level
 * security showed it only its own account's rows.
 *
 * The keys stay as they are. Loosening them is what once turned a loud failure
 * into an upsert that moved one session's turn into another.
 *
 * Instead each function is SECURITY DEFINER and owned by `memoar_row_id_probe`,
 * a NOLOGIN role made for nothing else. The tables FORCE row-level security,
 * which binds even their owner, and the migration role is deliberately neither
 * a superuser nor BYPASSRLS. So the probe role is given exactly what the
 * function needs and no more:
 *
 * - SELECT on three columns of each table: the id, the tenant and the session.
 *   Not the content.
 * - A SELECT policy that applies to that role alone. memoar_app is not a member
 *   and cannot become one, so its own policies are untouched.
 *
 * Each function takes candidate ids and returns the ones that exist outside the
 * given session. It returns no tenant, no session and no content, and the
 * caller must already hold the ids it asks about.
 *
 * Creating the role needs CREATEROLE, which the migration role already uses to
 * create memoar_app. It grants itself the right to SET the new role, because
 * handing a function to another owner requires that, and does not inherit it,
 * so the migration role's own reads stay filtered as before.
 */
export class ForeignRowIds1700000020000 implements MigrationInterface {
  name = "ForeignRowIds1700000020000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
          CREATE ROLE ${PROBE_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`GRANT ${PROBE_ROLE} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`);
    await queryRunner.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${PROBE_ROLE}`);
    for (const [name, table] of PROBES) {
      await queryRunner.query(`GRANT SELECT (id, "tenantId", "sessionId") ON ${table} TO ${PROBE_ROLE}`);
      await queryRunner.query(`CREATE POLICY ${table}_row_id_probe ON ${table} FOR SELECT TO ${PROBE_ROLE} USING (true)`);
      await queryRunner.query(`
        CREATE FUNCTION ${name}(candidates uuid[], owner_tenant uuid, owner_session uuid)
        RETURNS SETOF uuid
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $probe$
          SELECT id FROM public.${table}
           WHERE id = ANY (candidates)
             AND NOT ("tenantId" = owner_tenant AND "sessionId" = owner_session)
        $probe$
      `);
      // Granted while the migration role still owns the function: once it is
      // handed over, only its new owner may change who can call it.
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${name}(uuid[], uuid, uuid) FROM PUBLIC`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${name}(uuid[], uuid, uuid) TO memoar_app`);
      await queryRunner.query(`ALTER FUNCTION ${name}(uuid[], uuid, uuid) OWNER TO ${PROBE_ROLE}`);
    }
    // Needed only to take ownership of the functions above.
    await queryRunner.query(`REVOKE CREATE ON SCHEMA public FROM ${PROBE_ROLE}`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name, table] of PROBES) {
      await queryRunner.query(`DROP FUNCTION IF EXISTS ${name}(uuid[], uuid, uuid)`);
      await queryRunner.query(`DROP POLICY IF EXISTS ${table}_row_id_probe ON ${table}`);
      await queryRunner.query(`REVOKE ALL ON ${table} FROM ${PROBE_ROLE}`);
    }
    await queryRunner.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`);
    await queryRunner.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  }
}

const PROBES: readonly (readonly [string, string])[] = [
  ["memoar_turn_ids_held_elsewhere", "turns"],
  ["memoar_block_ids_held_elsewhere", "content_blocks"],
];
