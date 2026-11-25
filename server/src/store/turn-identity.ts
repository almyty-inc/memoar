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

/**
 * Gives a turn or block id that repeats within one session a distinct id for
 * each later occurrence.
 *
 * The Postgres store wrote rows one `save()` at a time, and a repeated id
 * turned the later row into an UPDATE of the earlier one, so a turn silently
 * replaced another. It now writes them as plain inserts, where a repeat fails
 * the whole save on the primary key. The first lost a turn and the second
 * would lose the session, so the repeat is kept as a row of its own. The first occurrence keeps its id, so a parent link
 * naming it still means the original, as the Claude Code parser already does
 * for the turns it reads. The derived ids depend only on the session and the
 * occurrence, so a re-capture gives them again.
 */
export function separateRepeatedIds(session: ArchivedSession): ArchivedSession {
  const turnsSeen = new Map<string, number>();
  const blocksSeen = new Map<string, number>();
  const next = (seen: Map<string, number>, id: string, space: string): string => {
    const repeats = seen.get(id);
    seen.set(id, (repeats ?? -1) + 1);
    return repeats === undefined ? id : derivedUuid(`${session.id}:${space}:${id}:repeat:${repeats + 1}`);
  };
  let changed = false;
  const turns = session.turns.map((turn) => {
    const id = next(turnsSeen, turn.id, "turn");
    const blocks = turn.blocks.map((block) => {
      const blockId = next(blocksSeen, block.id, "block");
      return blockId === block.id ? block : { ...block, id: blockId };
    });
    if (id === turn.id && blocks.every((block, index) => block === turn.blocks[index])) return turn;
    changed = true;
    return { ...turn, id, blocks };
  });
  return changed ? { ...session, turns } : session;
}
