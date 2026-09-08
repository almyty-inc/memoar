import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Distillation credentials belong to the account, not to the operator.
 *
 * Distillation was configured with a server-wide MEMOAR_DISTILLATION_PROVIDER
 * and one ANTHROPIC_API_KEY. In a multi-tenant archive that meant a single
 * operator key paid for every tenant, and every tenant's session content went
 * through the operator's provider account. It is the only feature that sends
 * archived content to a third party, so the consent and the bill belong to the
 * account that owns the sessions.
 *
 * The key is stored AES-256-GCM sealed and never returned by any endpoint. This
 * table is in every backup and every restore; a dump carrying usable customer
 * credentials would make a lost backup much worse than a lost archive.
 */
export class TenantProviderCredentials1700000012000 implements MigrationInterface {
  name = "TenantProviderCredentials1700000012000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE account_settings ADD COLUMN "distillationProvider" text`);
    await queryRunner.query(`ALTER TABLE account_settings ADD COLUMN "distillationModel" text`);
    await queryRunner.query(`ALTER TABLE account_settings ADD COLUMN "distillationApiKey" text`);

    // Existing rows chose nothing, which is not the same as being switched off:
    // an account can be enabled and still have no provider to distill with.
    await queryRunner.query(`UPDATE account_settings SET "distillationProvider" = 'none' WHERE "distillationProvider" IS NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE account_settings DROP COLUMN "distillationApiKey"`);
    await queryRunner.query(`ALTER TABLE account_settings DROP COLUMN "distillationModel"`);
    await queryRunner.query(`ALTER TABLE account_settings DROP COLUMN "distillationProvider"`);
  }
}
