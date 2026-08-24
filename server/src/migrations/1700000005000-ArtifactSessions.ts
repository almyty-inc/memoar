import type { MigrationInterface, QueryRunner } from "typeorm";

export class ArtifactSessions1700000005000 implements MigrationInterface {
  name = "ArtifactSessions1700000005000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS artifact_sessions (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "artifactId" uuid NOT NULL,
        "sessionId" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("artifactId", "sessionId")
      );
      CREATE INDEX IF NOT EXISTS artifact_sessions_tenant_idx ON artifact_sessions ("tenantId");
      CREATE INDEX IF NOT EXISTS artifact_sessions_artifact_idx ON artifact_sessions ("artifactId");
      CREATE INDEX IF NOT EXISTS artifact_sessions_session_idx ON artifact_sessions ("sessionId");
    `);
    await queryRunner.query(`
      INSERT INTO artifact_sessions (id, "tenantId", "artifactId", "sessionId")
      SELECT gen_random_uuid(), "tenantId", id, "sessionId"
      FROM raw_artifacts
      WHERE "sessionId" IS NOT NULL
      ON CONFLICT ("artifactId", "sessionId") DO NOTHING
    `);
    await queryRunner.query("ALTER TABLE artifact_sessions ENABLE ROW LEVEL SECURITY");
    await queryRunner.query("ALTER TABLE artifact_sessions FORCE ROW LEVEL SECURITY");
    await queryRunner.query(`
      DO $policy$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = current_schema() AND tablename = 'artifact_sessions' AND policyname = 'artifact_sessions_tenant_policy'
        ) THEN
          CREATE POLICY artifact_sessions_tenant_policy ON artifact_sessions
          USING ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid)
          WITH CHECK ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid);
        END IF;
      END $policy$;
    `);
    await queryRunner.query('ALTER TABLE raw_artifacts DROP COLUMN IF EXISTS "sessionId"');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE raw_artifacts ADD COLUMN IF NOT EXISTS "sessionId" uuid');
    await queryRunner.query(`
      UPDATE raw_artifacts SET "sessionId" = joined."sessionId"
      FROM (
        SELECT DISTINCT ON ("artifactId") "artifactId", "sessionId"
        FROM artifact_sessions
        ORDER BY "artifactId", "createdAt" ASC
      ) joined
      WHERE raw_artifacts.id = joined."artifactId"
    `);
    await queryRunner.query("DROP TABLE IF EXISTS artifact_sessions CASCADE");
  }
}
