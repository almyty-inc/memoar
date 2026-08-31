import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The instruction files an agent reads before it does anything: CLAUDE.md,
 * AGENTS.md, .goosehints and the rest. They are not transcripts — they have no
 * turns — but they are the standing context every transcript was produced
 * under, and without them an archived session cannot be read for what it
 * actually was.
 *
 * A document is identified by where it lives, because the same file read again
 * after an edit is the same document, not a new one. Its history is kept as
 * revisions: how a project's instructions changed is the part worth archiving,
 * and it is exactly what overwriting destroys.
 */
export class MemoryDocuments1700000011000 implements MigrationInterface {
  name = "MemoryDocuments1700000011000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE memory_documents (
        "id" uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "scope" text NOT NULL,
        "machineId" uuid NOT NULL,
        "workspacePath" text,
        "path" text NOT NULL,
        "title" text NOT NULL,
        "readers" text[] NOT NULL DEFAULT '{}',
        "contentHash" text NOT NULL,
        "capturedAt" timestamptz NOT NULL,
        "visibility" jsonb NOT NULL,
        "provenance" jsonb NOT NULL DEFAULT '[]',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX memory_documents_tenant_idx ON memory_documents ("tenantId")`);
    await queryRunner.query(`CREATE INDEX memory_documents_machine_idx ON memory_documents ("tenantId", "machineId")`);
    // One file, one document. Capturing it again updates it rather than adding
    // a second copy that claims to be a different file.
    await queryRunner.query(`CREATE UNIQUE INDEX memory_documents_identity_key ON memory_documents ("tenantId", "machineId", "path")`);

    await queryRunner.query(`
      CREATE TABLE memory_revisions (
        "id" uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "documentId" uuid NOT NULL REFERENCES memory_documents ("id") ON DELETE CASCADE,
        "contentHash" text NOT NULL,
        "text" text NOT NULL,
        "size" integer NOT NULL,
        "capturedAt" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX memory_revisions_tenant_idx ON memory_revisions ("tenantId")`);
    await queryRunner.query(`CREATE INDEX memory_revisions_document_idx ON memory_revisions ("documentId", "capturedAt" DESC)`);
    // Re-reading an unchanged file must not add to its history: the agent
    // uploads on a timer, and most of the time nothing has changed.
    await queryRunner.query(`CREATE UNIQUE INDEX memory_revisions_content_key ON memory_revisions ("tenantId", "documentId", "contentHash")`);

    for (const table of ["memory_documents", "memory_revisions"]) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${table}_tenant_policy ON ${table}
        USING ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid)
        WITH CHECK ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid)
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE memory_revisions`);
    await queryRunner.query(`DROP TABLE memory_documents`);
  }
}
