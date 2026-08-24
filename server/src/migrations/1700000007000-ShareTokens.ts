import type { MigrationInterface, QueryRunner } from "typeorm";

export class ShareTokens1700000007000 implements MigrationInterface {
  name = "ShareTokens1700000007000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE share_tokens (
        "id" uuid PRIMARY KEY,
        "tokenHash" text NOT NULL,
        "tenantId" uuid NOT NULL,
        "sessionId" uuid NOT NULL,
        "permission" text NOT NULL,
        "status" text NOT NULL DEFAULT 'active',
        "expiresAt" timestamptz
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX share_tokens_token_hash_idx ON share_tokens ("tokenHash")`);
    // Backfill from share_grants. That table is under FORCE RLS, so lift FORCE
    // for the owner inside this migration transaction only.
    await queryRunner.query(`ALTER TABLE share_grants NO FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      INSERT INTO share_tokens ("id", "tokenHash", "tenantId", "sessionId", "permission", "status", "expiresAt")
      SELECT "id", "tokenHash", "tenantId", "sessionId", "permission", "status", "expiresAt" FROM share_grants
    `);
    await queryRunner.query(`ALTER TABLE share_grants FORCE ROW LEVEL SECURITY`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE share_tokens`);
  }
}
