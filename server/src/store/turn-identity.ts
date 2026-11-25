import { derivedUuid } from "../../libs/parsers/src/common.js";
import type { ArchivedSession } from "./context.js";

/** Turn and block ids, one set each. */
export interface RowIds {
  turns: ReadonlySet<string>;
  blocks: ReadonlySet<string>;
}

export const NO_ROW_IDS: RowIds = { turns: new Set(), blocks: new Set() };

/** The id a turn is given when its own is held by a row this session does not own. */
export function rescopedTurnId(sessionId: string, turnId: string): string {
  return derivedUuid(`${sessionId}:turn:${turnId}`);
}

/** The same for a block, in its own name space. */
export function rescopedBlockId(sessionId: string, blockId: string): string {
  return derivedUuid(`${sessionId}:block:${blockId}`);
}

/**
 * Gives a turn or block a session-scoped id when its own id already belongs to
 * a row outside this session, and leaves every other one exactly as it is.
 *
 * `turns.id` and `content_blocks.id` are primary keys across the whole archive,
 * every account included, but a parser passes a native uuid through unchanged,
 * and native uuids are only unique within the file that wrote them. Two ways
 * to arrive with an id somebody else holds:
 *
 * - Claude Desktop's local agent mode writes an `audit.jsonl` beside
 *   `<id>-outputs/*.jsonl` that reuse record uuids across files, so two
 *   sessions of one account carry the same turn id.
 * - Two accounts upload the same transcript. The second save failed with
 *   `duplicate key value violates unique constraint "turns_pkey"`, because the
 *   lookup that found colliding ids ran under the tenant's row-level security
 *   and could not see the first account's rows.
 *
 * Unhandled, both fail loudly. The fix first proposed for the first case,
 * adding `sessionId` to the block key, was worse: the save then succeeded, and
 * the second session's upsert moved the shared turn row into itself, so the
 * first session silently lost its turn. So no key is loosened. The collision is
 * resolved where it arises, at the row.
 *
 * Only ids that are held elsewhere are rescoped, which keeps two properties:
 * nothing already stored is renumbered, and a session captured again as it
 * grows keeps the same ids, so annotations anchored to them stay put. An id
 * this session already stores in its rescoped form stays rescoped even after
 * the other holder is gone, for the same reason.
 *
 * Parent links are rewritten through the same map, or a turn would point at an
 * id that now names a turn in somebody else's session.
 */
export function scopeCollidingIds(session: ArchivedSession, heldElsewhere: RowIds, storedHere: RowIds = NO_ROW_IDS): ArchivedSession {
  const turnIds = new Map<string, string>();
  const blockIds = new Map<string, string>();
  for (const turn of session.turns) {
    const turnScoped = rescopedTurnId(session.id, turn.id);
    if (heldElsewhere.turns.has(turn.id) || storedHere.turns.has(turnScoped)) turnIds.set(turn.id, turnScoped);
    for (const block of turn.blocks) {
      const blockScoped = rescopedBlockId(session.id, block.id);
      if (heldElsewhere.blocks.has(block.id) || storedHere.blocks.has(blockScoped)) blockIds.set(block.id, blockScoped);
    }
  }
  if (turnIds.size === 0 && blockIds.size === 0) return session;
  const remap = (id: string | null): string | null => (id === null ? null : turnIds.get(id) ?? id);
  return {
    ...session,
    turns: session.turns.map((turn) => ({
      ...turn,
      id: remap(turn.id)!,
      parentId: remap(turn.parentId),
      blocks: turn.blocks.map((block) => ({ ...block, id: blockIds.get(block.id) ?? block.id })),
    })),
  };
}
