import type { MigrationInterface, QueryRunner } from "typeorm";

export class SessionIdentity1700000002000 implements MigrationInterface {
  name = "SessionIdentity1700000002000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS session_identities (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "sourceTool" text NOT NULL,
        "sourceVersion" text NOT NULL,
        "nativeSessionId" text NOT NULL,
        "sessionId" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("tenantId", "sourceTool", "nativeSessionId")
      );
      CREATE INDEX IF NOT EXISTS session_identities_tenant_idx ON session_identities ("tenantId");
      CREATE INDEX IF NOT EXISTS session_identities_session_idx ON session_identities ("sessionId");
    `);
    await queryRunner.query("ALTER TABLE session_identities ENABLE ROW LEVEL SECURITY");
    await queryRunner.query("ALTER TABLE session_identities FORCE ROW LEVEL SECURITY");
    await queryRunner.query(`
      DO $policy$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = current_schema() AND tablename = 'session_identities' AND policyname = 'session_identities_tenant_policy'
        ) THEN
          CREATE POLICY session_identities_tenant_policy ON session_identities
          USING ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid)
          WITH CHECK ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid);
        END IF;
      END $policy$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE IF EXISTS session_identities CASCADE");
  }
}
