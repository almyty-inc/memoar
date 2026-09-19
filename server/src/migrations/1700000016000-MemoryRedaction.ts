import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Whether anyone has looked at what a memory file says before it leaves here.
 *
 * Redaction matters more on these than on transcripts. A memory file is where
 * somebody writes "the staging key is sk-…" and the project's customer names,
 * and unlike a transcript nobody ever re-reads one: it is written once and then
 * consulted by machines. So the scanner runs at capture and the result is
 * recorded on the row, exactly as `sessions.redactionStatus` records it.
 *
 * Existing rows default to `findings` rather than to `clear`, because they are
 * not clear — they were captured before anything scanned them, and calling them
 * clear would be the archive asserting something it never measured. The agent
 * re-reads these files on a timer, so a real scan replaces the default within
 * one capture cycle; until it does, the egress gate holds them.
 */
export class MemoryRedaction1700000016000 implements MigrationInterface {
  name = "MemoryRedaction1700000016000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE memory_documents
      ADD COLUMN "redactionStatus" text NOT NULL DEFAULT 'findings',
      ADD COLUMN "redactionFindings" text[] NOT NULL DEFAULT '{}'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE memory_documents
      DROP COLUMN "redactionStatus",
      DROP COLUMN "redactionFindings"
    `);
  }
}
