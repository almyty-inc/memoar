import type { MigrationInterface, QueryRunner } from "typeorm";

export class TenantSettings1700000006000 implements MigrationInterface {
  name = "TenantSettings1700000006000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE account_settings ADD COLUMN "redaction" jsonb`);
    await queryRunner.query(`ALTER TABLE account_settings ADD COLUMN "retention" jsonb`);
    await queryRunner.query(`ALTER TABLE account_settings ADD COLUMN "settingsUpdatedAt" timestamptz`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE account_settings DROP COLUMN "settingsUpdatedAt"`);
    await queryRunner.query(`ALTER TABLE account_settings DROP COLUMN "retention"`);
    await queryRunner.query(`ALTER TABLE account_settings DROP COLUMN "redaction"`);
  }
}
