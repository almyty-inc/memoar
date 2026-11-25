import type { EntityManager, EntitySchema, ObjectLiteral } from "typeorm";
import { ContentBlockEntity, TurnEntity, type ContentBlockRow, type TurnRow } from "../../entities.js";
import type { ArchivedSession } from "../context.js";

/**
 * Bind parameters per insert statement.
 *
 * Postgres refuses more than 65535, and TypeORM spreads the parameter list
 * when it builds the statement, so a statement near that ceiling is also one
 * spread away from `Maximum call stack size exceeded`. Twenty thousand keeps
 * well clear of both while still writing about 1,400 blocks or 2,000 turns per
 * round trip.
 */
const PARAMETERS_PER_INSERT = 20_000;

/** The turn rows of a session whose ids have already been scoped. */
export function turnRows(tenantId: string, session: ArchivedSession): TurnRow[] {
  return session.turns.map((turn) => ({
    id: turn.id,
    tenantId,
    sessionId: session.id,
    ordinal: turn.ordinal,
    parentId: turn.parentId,
    role: turn.role,
    capturedAt: new Date(turn.createdAt),
    model: turn.model ?? null,
    tokens: turn.tokens ?? null,
    ext: turn.ext ?? null,
  }));
}

/** The block rows of the same session, numbered within their turn. */
export function blockRows(tenantId: string, session: ArchivedSession): ContentBlockRow[] {
  return session.turns.flatMap((turn) => turn.blocks.map((block, ordinal) => ({
    id: block.id,
    tenantId,
    sessionId: session.id,
    turnId: turn.id,
    ordinal,
    kind: block.kind,
    text: block.text ?? null,
    name: block.name ?? null,
    callId: block.callId ?? null,
    language: block.language ?? null,
    mimeType: block.mimeType ?? null,
    artifactRef: block.artifactRef ?? null,
    data: block.data ?? null,
    ext: block.ext ?? null,
  })));
}

/**
 * Writes a session's turns, then its blocks, as multi-row inserts.
 *
 * These are plain inserts, not `save()`. The save has just deleted every row
 * this session owned and rescoped every id held anywhere else, so an id that
 * still meets a row here is a fault and has to fail as one. `save()` would
 * instead read each row back by id to choose between INSERT and UPDATE, which
 * cost two round trips per turn and per block, and would turn exactly that
 * fault into an UPDATE that moves another session's row into this one.
 */
export async function insertSessionRows(manager: EntityManager, tenantId: string, session: ArchivedSession): Promise<void> {
  await insertInBatches(manager, TurnEntity, turnRows(tenantId, session));
  await insertInBatches(manager, ContentBlockEntity, blockRows(tenantId, session));
}

async function insertInBatches<T extends ObjectLiteral>(manager: EntityManager, entity: EntitySchema<T>, rows: T[]): Promise<void> {
  const first = rows[0];
  if (!first) return;
  const batch = Math.max(1, Math.floor(PARAMETERS_PER_INSERT / Object.keys(first).length));
  for (let index = 0; index < rows.length; index += batch) {
    await manager.createQueryBuilder()
      .insert()
      .into(entity)
      .values(rows.slice(index, index + batch))
      .updateEntity(false)
      .execute();
  }
}
