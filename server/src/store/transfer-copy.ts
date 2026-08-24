import { uuidV7 } from "../ids.js";
import { applyRedactionProjection } from "../redaction.js";
import type { ArchivedSession } from "./context.js";

/**
 * Builds the recipient-tenant copy of a transferred or share-imported session:
 * fresh session, turn, and block ids (turn parent links remapped), private
 * visibility owned by the recipient, and an appended import provenance entry
 * citing the transfer or share grant.
 */
export function copyTransferredSession(source: ArchivedSession, transferId: string, ownerId: string, provenancePrefix = "transfer"): ArchivedSession {
  const clone = structuredClone(source);
  const turnIdMap = new Map<string, string>();
  for (const turn of clone.turns) turnIdMap.set(turn.id, uuidV7());
  const turns = clone.turns.map((turn) => ({
    ...turn,
    id: turnIdMap.get(turn.id)!,
    parentId: turn.parentId ? turnIdMap.get(turn.parentId) ?? turn.parentId : turn.parentId,
    blocks: turn.blocks.map((block) => ({ ...block, id: uuidV7() })),
  }));
  return applyRedactionProjection({
    ...clone,
    id: uuidV7(),
    turns,
    visibility: { scope: "private", ownerId },
    provenance: [...clone.provenance, {
      kind: "import",
      sourceId: `${provenancePrefix}:${transferId}:${source.id}`,
      capturedAt: new Date().toISOString(),
    }],
  });
}
