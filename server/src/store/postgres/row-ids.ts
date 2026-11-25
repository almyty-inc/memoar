import type { EntityManager } from "typeorm";
import type { ArchivedSession } from "../context.js";
import type { RowIds } from "../turn-identity.js";

/** Ids per lookup: one array parameter, but a bounded statement all the same. */
const LOOKUP_BATCH = 1000;

/**
 * Which of a session's turn and block ids are held by a row it does not own,
 * in this account or any other.
 *
 * The runtime role cannot see another account's rows, and that is the point of
 * row-level security, so a lookup it ran itself answered only for its own
 * account. The ids are primary keys across every account, so a second account
 * uploading the same transcript met the first account's rows at the insert and
 * failed on `turns_pkey`. The two `memoar_turn_ids_held_elsewhere` and
 * `memoar_block_ids_held_elsewhere` functions are SECURITY DEFINER (see the
 * ForeignRowIds migration). They answer which of the given ids exist outside
 * this session and return nothing else: no tenant, no session, no content.
 *
 * Asked inside the save's lock, so the answer is the one the inserts meet.
 */
export async function rowIdsHeldElsewhere(manager: EntityManager, tenantId: string, session: ArchivedSession): Promise<RowIds> {
  const turnIds = session.turns.map((turn) => turn.id);
  const blockIds = session.turns.flatMap((turn) => turn.blocks.map((block) => block.id));
  return {
    turns: await held(manager, "memoar_turn_ids_held_elsewhere", turnIds, tenantId, session.id),
    blocks: await held(manager, "memoar_block_ids_held_elsewhere", blockIds, tenantId, session.id),
  };
}

/** The ids this session stores now, read before the save replaces them. */
export async function rowIdsStoredHere(manager: EntityManager, tenantId: string, sessionId: string): Promise<RowIds> {
  const turns = await idRows(manager, `SELECT id FROM turns WHERE "tenantId" = $1 AND "sessionId" = $2`, [tenantId, sessionId]);
  const blocks = await idRows(manager, `SELECT id FROM content_blocks WHERE "tenantId" = $1 AND "sessionId" = $2`, [tenantId, sessionId]);
  return { turns: new Set(turns), blocks: new Set(blocks) };
}

async function held(manager: EntityManager, probe: string, ids: readonly string[], tenantId: string, sessionId: string): Promise<Set<string>> {
  const found = new Set<string>();
  for (let index = 0; index < ids.length; index += LOOKUP_BATCH) {
    const batch = ids.slice(index, index + LOOKUP_BATCH);
    for (const id of await idRows(manager, `SELECT id FROM ${probe}($1::uuid[], $2::uuid, $3::uuid) AS id`, [batch, tenantId, sessionId])) {
      found.add(id);
    }
  }
  return found;
}

async function idRows(manager: EntityManager, sql: string, parameters: unknown[]): Promise<string[]> {
  const rows: unknown = await manager.query(sql, parameters);
  return (rows as { id: string }[]).map((row) => row.id);
}
