import type { MigrationInterface, QueryRunner } from "typeorm";
import { repairLatin1Utf8 } from "../ingest/source-path.js";

/** Values with a character between U+0080 and U+00FF: the only ones a latin1 reading can have garbled. */
const SUSPECT = String.raw`~ '[\u0080-ÿ]'`;

/**
 * Repairs capture paths that were stored as latin1 readings of UTF-8.
 *
 * The agent sent `x-memoar-source-path` as raw UTF-8 and Node read the header
 * as latin1, so every non-ASCII path was stored garbled. The repair is exact,
 * not a guess: latin1 maps each byte to one character, so the stored text
 * converts back to the bytes the agent sent, and those bytes are kept only if
 * they decode as strict UTF-8. `repairLatin1Utf8` is the same function the
 * server applies to a header from an agent older than the encoding.
 *
 * Four places hold a header-derived path:
 *
 * - `raw_artifacts.sourcePath`, set only from the header.
 * - `session_identities.nativeSessionId` and `sessions.source.nativeSessionId`
 *   for formats with no session id of their own, which fall back to
 *   `path:<machine>:<path>`. Repairing the identity row is what keeps the next
 *   capture, now decoded correctly, landing on the same session instead of
 *   starting a second one.
 * - `sessions.workspace.path` when the parser found no working directory in
 *   the transcript. Only a value equal to some artifact's stored path is
 *   touched, so a directory a transcript named in its own UTF-8 body is never
 *   rewritten.
 *
 * Row-level security filters the migration role unless it is a superuser or
 * holds BYPASSRLS. Without that this migration repairs nothing and changes
 * nothing, and the server still decodes every new capture correctly.
 *
 * Not reversible, by design: the garbled form carries no information the
 * repaired one lacks.
 */
export class SourcePathUtf81700000021000 implements MigrationInterface {
  name = "SourcePathUtf81700000021000";

  async up(queryRunner: QueryRunner): Promise<void> {
    // Workspaces first, while artifact paths still hold the garbled form they are matched against.
    const workspaces = await rows<{ id: string; path: string }>(queryRunner, `
      SELECT s.id, s.workspace->>'path' AS path FROM sessions s
       WHERE s.workspace->>'path' ${SUSPECT}
         AND EXISTS (SELECT 1 FROM raw_artifacts a WHERE a."sourcePath" = s.workspace->>'path')`);
    for (const row of repairable(workspaces, "path")) {
      await queryRunner.query(`UPDATE sessions SET workspace = jsonb_set(workspace, '{path}', to_jsonb($2::text)) WHERE id = $1`, [row.id, row.repaired]);
    }

    const sources = await rows<{ id: string; native: string }>(queryRunner, `
      SELECT id, source->>'nativeSessionId' AS native FROM sessions
       WHERE source->>'nativeSessionId' LIKE 'path:%' AND source->>'nativeSessionId' ${SUSPECT}`);
    for (const row of repairable(sources, "native")) {
      await queryRunner.query(`UPDATE sessions SET source = jsonb_set(source, '{nativeSessionId}', to_jsonb($2::text)) WHERE id = $1`, [row.id, row.repaired]);
    }

    const identities = await rows<{ id: string; native: string }>(queryRunner, `
      SELECT id, "nativeSessionId" AS native FROM session_identities
       WHERE "nativeSessionId" LIKE 'path:%' AND "nativeSessionId" ${SUSPECT}`);
    for (const row of repairable(identities, "native")) {
      // Skipped if the repaired identity already exists, which only a capture
      // decoded after this release could have made. Its session is the live one.
      await queryRunner.query(`
        UPDATE session_identities target SET "nativeSessionId" = $2, "updatedAt" = now()
         WHERE target.id = $1
           AND NOT EXISTS (
             SELECT 1 FROM session_identities other
              WHERE other."tenantId" = target."tenantId" AND other."sourceTool" = target."sourceTool"
                AND other."nativeSessionId" = $2)`, [row.id, row.repaired]);
    }

    const artifacts = await rows<{ id: string; path: string }>(queryRunner, `
      SELECT id, "sourcePath" AS path FROM raw_artifacts WHERE "sourcePath" ${SUSPECT}`);
    for (const row of repairable(artifacts, "path")) {
      await queryRunner.query(`UPDATE raw_artifacts SET "sourcePath" = $2 WHERE id = $1`, [row.id, row.repaired]);
    }
  }

  async down(): Promise<void> {
    // Nothing to undo. See the class comment.
  }
}

async function rows<T>(queryRunner: QueryRunner, sql: string): Promise<T[]> {
  const result: unknown = await queryRunner.query(sql);
  return result as T[];
}

function repairable<T extends { id: string }>(found: readonly T[], field: keyof T): { id: string; repaired: string }[] {
  return found.flatMap((row) => {
    const value = row[field];
    if (typeof value !== "string") return [];
    const repaired = repairLatin1Utf8(value);
    return repaired === value ? [] : [{ id: row.id, repaired }];
  });
}
