import type { MigrationInterface, QueryRunner } from "typeorm";

export class ReviewMaskSnapshot1700000004000 implements MigrationInterface {
  name = "ReviewMaskSnapshot1700000004000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE redaction_reviews
      ADD COLUMN IF NOT EXISTS masks jsonb NOT NULL DEFAULT '[]'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE redaction_reviews DROP COLUMN IF EXISTS masks");
  }
}
