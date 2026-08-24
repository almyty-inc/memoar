import type { MigrationInterface, QueryRunner } from "typeorm";

export class CredentialBilling1700000001000 implements MigrationInterface {
  name = "CredentialBilling1700000001000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth_identities (
        id uuid PRIMARY KEY,
        kind text NOT NULL CHECK (kind IN ('password', 'api_key', 'machine_token')),
        "lookupKey" citext NOT NULL,
        "tenantId" uuid NOT NULL,
        "userId" uuid NOT NULL REFERENCES users(id),
        "secretHash" text NOT NULL,
        scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
        "machineId" uuid,
        "expiresAt" timestamptz,
        "revokedAt" timestamptz,
        "lastUsedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE (kind, "lookupKey")
      );
      CREATE INDEX IF NOT EXISTS auth_identities_tenant_idx ON auth_identities ("tenantId");
      CREATE INDEX IF NOT EXISTS auth_identities_machine_idx ON auth_identities ("machineId") WHERE "machineId" IS NOT NULL;

      CREATE TABLE IF NOT EXISTS billing_accounts (
        id uuid PRIMARY KEY, "tenantId" uuid NOT NULL, provider text NOT NULL DEFAULT 'stub',
        status text NOT NULL DEFAULT 'inactive', "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS billing_subscriptions (
        id uuid PRIMARY KEY, "tenantId" uuid NOT NULL,
        "billingAccountId" uuid NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
        plan text NOT NULL DEFAULT 'none', status text NOT NULL DEFAULT 'inactive',
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
    `);
    for (const table of ["billing_accounts", "billing_subscriptions"]) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        DO $policy$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = current_schema() AND tablename = '${table}' AND policyname = '${table}_tenant_policy'
          ) THEN
            CREATE POLICY ${table}_tenant_policy ON ${table}
            USING ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid)
            WITH CHECK ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid);
          END IF;
        END $policy$;
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE IF EXISTS billing_subscriptions, billing_accounts, auth_identities CASCADE");
  }
}
