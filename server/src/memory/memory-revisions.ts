import type { MemoryDocument, MemoryRevision } from "../../libs/canonical/src/generated.js";

/**
 * The revision the document actually points at.
 *
 * Not the newest one. A file edited and then reverted reuses the revision
 * already recorded for that text — deliberately, because it is the same text —
 * and that row keeps its original `capturedAt`. So after A, then B, then back
 * to A, the history reads [B, A] newest-first while the document says A, and
 * taking the head returns B's text beside A's hash: two different versions
 * presented as one.
 *
 * Shared rather than copied, because both callers are egress — MCP hands the
 * text to a model, conversion writes it onto a disk — and a rule this easy to
 * get wrong should exist once.
 */
export function currentRevision(
  document: Pick<MemoryDocument, "contentHash">,
  revisions: readonly MemoryRevision[],
): MemoryRevision | null {
  return revisions.find((revision) => revision.contentHash === document.contentHash)
    ?? revisions.at(0)
    ?? null;
}

export function currentText(
  document: Pick<MemoryDocument, "contentHash">,
  revisions: readonly MemoryRevision[],
): string {
  return currentRevision(document, revisions)?.text ?? "";
}
