import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A deregistered machine is retired, not deleted.
 *
 * The machine id is held by the archive it produced, with no foreign key to
 * follow: `sessions.source.machineId`, `memory_documents."machineId"`,
 * `machine_commands."machineId"` and `team_share_optins."machineId"`. Deleting
 * the row would leave every one of those pointing at nothing. The one table
 * that does reference `machines(id)` is `machine_tokens`, without a cascade, so
 * a delete would also have to destroy the record of which tokens were revoked.
 *
 * A retired machine is invisible to every read that asks for a live machine,
 * so it cannot mint or use a token. Its installation id no longer claims the
 * unique slot: the same installation enrolling again is a new machine.
 */
export class MachineRetirement1700000018000 implements MigrationInterface {
  name = "MachineRetirement1700000018000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE machines ADD COLUMN "retiredAt" timestamptz`);
    await queryRunner.query(`DROP INDEX IF EXISTS machines_installation_key`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX machines_installation_key
      ON machines ("tenantId", "installationId")
      WHERE "installationId" IS NOT NULL AND "retiredAt" IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS machines_installation_key`);
    // The rows stay, because the archive still names them. A retired machine
    // gives up its installation id so the older, wider index can hold.
    await queryRunner.query(`UPDATE machines SET "installationId" = NULL WHERE "retiredAt" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE machines DROP COLUMN "retiredAt"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX machines_installation_key
      ON machines ("tenantId", "installationId")
      WHERE "installationId" IS NOT NULL
    `);
  }
}
