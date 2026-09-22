import { derivedUuid } from "../../libs/parsers/src/common.js";
import type { ArchivedSession } from "./context.js";

/**
 * Gives a turn a session-scoped id when its own id already belongs to another
 * session, and leaves every other turn exactly as it is.
 *
 * `turns.id` is a primary key across the whole archive, but a parser passes a
 * native uuid through unchanged, and native uuids are only unique within the
 * file that wrote them. Claude Desktop's local agent mode writes an
 * `audit.jsonl` beside `<id>-outputs/*.jsonl` that reuse record uuids across
 * files, so two different sessions arrive carrying the same turn id.
 *
 * Unhandled, that failed loudly: the second session's blocks collided on
 * `content_blocks_tenantId_turnId_ordinal_key` and the whole save was lost —
 * 16 artifacts, 197 MB, on the dev archive. The fix first proposed for it,
 * adding `sessionId` to that block key, was worse: the save then succeeded,
 * and the second session's upsert moved the shared turn row into itself, so
 * the first session silently lost its turn. A contract test caught it before
 * it shipped.
 *
 * So the collision is resolved where it arises, at the turn. Only ids that are
 * already taken by another session are rescoped, which keeps two properties:
 * nothing already stored is renumbered, and a session captured again as it
 * grows keeps the same turn ids — so annotations anchored to them stay put.
 * The rescoped id is derived from the canonical session id, so it is stable
 * across captures too.
 *
 * Parent links are rewritten through the same map, or a turn would point at an
 * id that now names a turn in somebody else's session.
 */
export function scopeCollidingTurns(session: ArchivedSession, takenElsewhere: ReadonlySet<string>): ArchivedSession {
  if (takenElsewhere.size === 0) return session;
  const rescoped = new Map<string, string>();
  for (const turn of session.turns) {
    if (takenElsewhere.has(turn.id)) rescoped.set(turn.id, derivedUuid(`${session.id}:turn:${turn.id}`));
  }
  if (rescoped.size === 0) return session;
  const remap = (id: string | null): string | null => (id === null ? null : rescoped.get(id) ?? id);
  return {
    ...session,
    turns: session.turns.map((turn) => ({ ...turn, id: remap(turn.id)!, parentId: remap(turn.parentId) })),
  };
}
