import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Indexes the columns a session's turns and blocks are found and deleted by.
 *
 * The canonical model declares indexes on `turns.sessionId`,
 * `content_blocks.sessionId` and `content_blocks.turnId`, and no migration ever
 * created them. The only indexes on those tables lead with `tenantId`, which
 * Postgres cannot use to look up a turn or session alone.
 *
 * Every save of a session deletes its turns, and `content_blocks_turnId_fkey`
 * is ON DELETE CASCADE, so Postgres looks for each deleted turn's blocks with
 * `WHERE "turnId" = $1`. Without an index on that column each lookup walked
 * the whole `(tenantId, turnId, ordinal)` index, once per turn. A re-capture
 * therefore cost the session's turns times every block in the archive: about
 * 4 ms per turn against 100,000 blocks, so a 14,000-turn transcript spent about
 * a minute in that one DELETE, and the cost grew with the archive. The agent
 * re-sends a growing transcript on every change, so re-capture is the common
 * path.
 *
 * The session lookups have the same shape. Deleting a session's blocks and
 * reading them back both scanned the whole table.
 *
 * Plain CREATE INDEX, because the migrations run in one transaction and
 * CONCURRENTLY cannot. Writes to the two tables wait while the indexes build.
 */
export class SessionRowIndexes1700000022000 implements MigrationInterface {
  name = "SessionRowIndexes1700000022000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS turns_session_idx ON turns ("sessionId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS content_blocks_session_idx ON content_blocks ("sessionId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS content_blocks_turn_idx ON content_blocks ("turnId")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS content_blocks_turn_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS content_blocks_session_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS turns_session_idx`);
  }
}
