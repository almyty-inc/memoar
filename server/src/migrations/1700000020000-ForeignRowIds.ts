import type { MigrationInterface, QueryRunner } from "typeorm";

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
 * into an upsert that moved one session's turn into another. Instead these
 * functions run as their owner, the migration role, which row-level security
 * does not filter. Each takes candidate ids and returns the ones that exist
 * outside the given session. It returns no tenant, no session and no content,
 * and the caller must already hold the ids it asks about.
 *
 * The owner must be a superuser or hold BYPASSRLS, as the migration role does
 * in every deployment this repository describes. If it does not, the functions
 * see only the caller's account and a cross-account collision fails loudly on
 * the primary key, as before. Nothing is ever merged.
 */
export class ForeignRowIds1700000020000 implements MigrationInterface {
  name = "ForeignRowIds1700000020000";

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, table] of PROBES) {
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
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${name}(uuid[], uuid, uuid) FROM PUBLIC`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${name}(uuid[], uuid, uuid) TO memoar_app`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of PROBES) await queryRunner.query(`DROP FUNCTION IF EXISTS ${name}(uuid[], uuid, uuid)`);
  }
}

const PROBES: readonly (readonly [string, string])[] = [
  ["memoar_turn_ids_held_elsewhere", "turns"],
  ["memoar_block_ids_held_elsewhere", "content_blocks"],
];
