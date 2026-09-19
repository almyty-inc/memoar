import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Which installation of the agent a machine belongs to.
 *
 * `POST /machines` created a row every time it was called, and the agent called
 * it on every `login`. One dev account reached five machines for one laptop —
 * four of them identical rows reading `memoar-machine` / `macos`, one per
 * re-login. Because a memory document is unique on (tenant, machine, path),
 * every surplus machine duplicated every instruction file the agent captured.
 *
 * Sessions never had this problem, and the reason is the shape of the fix:
 * `session_identities` maps a client-supplied `nativeSessionId` to a canonical
 * id, so re-uploading the same transcript resolves to the row that already
 * exists. This is that, for machines. The installation id is supplied by the
 * client and compared, never inferred: the archive cannot tell two laptops
 * apart by name and platform, and guessing wrong would merge two machines into
 * one — which, given the unique key above, destroys memory documents rather
 * than duplicating them.
 *
 * The index is partial. A row without an installation id is a machine some
 * other client registered, or one enrolled before this column existed, and
 * every such row has to stay allowed to coexist with every other.
 */
export class MachineInstallation1700000017000 implements MigrationInterface {
  name = "MachineInstallation1700000017000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE machines ADD COLUMN "installationId" text`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX machines_installation_key
      ON machines ("tenantId", "installationId")
      WHERE "installationId" IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS machines_installation_key`);
    await queryRunner.query(`ALTER TABLE machines DROP COLUMN "installationId"`);
  }
}
