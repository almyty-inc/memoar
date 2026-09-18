import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Standing consent to share what a machine captures with one team.
 *
 * A team workspace is the team that already exists: a grouping *across*
 * tenants. No session moves, no session is re-stamped with somebody else's
 * tenant, and no row-level security policy changes. All this table records is
 * that a tenant has agreed, in advance, that sessions captured from here on
 * should be widened to a team at ingest — the widening itself is written into
 * `sessions.visibility`, where every existing read path already looks.
 *
 * Deliberately not under RLS, for the reason `team_members`, `transfer_offers`
 * and `share_tokens` are not: it carries consent metadata, never session
 * content. If a content-bearing column is ever added here, that rationale is
 * gone and the table must join the forced set. `test/rls.test.ts` names it in
 * CROSS_TENANT_LOOKUPS so the exemption is stated once and checked.
 *
 * `machineId` is a plain uuid rather than a foreign key: `machines` is under
 * forced RLS, so a reference from an unpoliced table would be a cross-policy
 * edge. Ownership of the machine is checked in the service before a row lands.
 */
export class TeamShareOptins1700000015000 implements MigrationInterface {
  name = "TeamShareOptins1700000015000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE team_share_optins (
        "id" uuid PRIMARY KEY,
        "teamId" uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        "tenantId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "machineId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    // NULLS NOT DISTINCT, because a null machineId means "every machine of this
    // tenant" and there can only be one such standing consent per team. Under
    // the default (nulls distinct) a caller could enrol the whole tenant twice
    // and then only revoke half of it.
    await queryRunner.query(`
      ALTER TABLE team_share_optins
      ADD CONSTRAINT team_share_optins_unique UNIQUE NULLS NOT DISTINCT ("teamId", "tenantId", "machineId")
    `);
    await queryRunner.query(`CREATE INDEX team_share_optins_team_idx ON team_share_optins ("teamId")`);
    // The ingest path asks this table a question per captured artifact: does
    // this tenant, on this machine, share into a team? That lookup is by tenant,
    // and it is the hot one.
    await queryRunner.query(`CREATE INDEX team_share_optins_tenant_idx ON team_share_optins ("tenantId")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE team_share_optins`);
  }
}
