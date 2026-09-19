import type { ContentBlockRow, SessionRow, TurnRow } from "../../entities.js";
import type { ArchivedSession } from "../context.js";

/** Builds a canonical session from its already-loaded rows. */
export function assembleSession(
  session: SessionRow,
  turns: readonly TurnRow[],
  blocksByTurn: ReadonlyMap<string, readonly ContentBlockRow[]>,
): ArchivedSession {
  return {
    id: session.id,
    source: session.source,
    workspace: session.workspace,
    createdAt: session.capturedCreatedAt.toISOString(),
    updatedAt: session.capturedUpdatedAt.toISOString(),
    title: session.title,
    ...(session.summary ? { summary: session.summary } : {}),
    models: session.models,
    tokenTotals: session.tokenTotals,
    provenance: session.provenance,
    visibility: session.visibility,
    turns: turns.map((turn) => ({
      id: turn.id,
      ordinal: turn.ordinal,
      parentId: turn.parentId,
      role: turn.role,
      createdAt: turn.capturedAt.toISOString(),
      ...(turn.model ? { model: turn.model } : {}),
      ...(turn.tokens ? { tokens: turn.tokens } : {}),
      blocks: (blocksByTurn.get(turn.id) ?? []).map((block) => ({
        id: block.id,
        kind: block.kind,
        ...(block.text !== null ? { text: block.text } : {}),
        ...(block.name !== null ? { name: block.name } : {}),
        ...(block.callId !== null ? { callId: block.callId } : {}),
        ...(block.language !== null ? { language: block.language } : {}),
        ...(block.mimeType !== null ? { mimeType: block.mimeType } : {}),
        ...(block.artifactRef !== null ? { artifactRef: block.artifactRef } : {}),
        ...(block.data !== null ? { data: block.data } : {}),
        ...(block.ext !== null ? { ext: block.ext } : {}),
      })),
      ...(turn.ext ? { ext: turn.ext } : {}),
    })),
    ...(session.ext ? { ext: session.ext } : {}),
    redactionStatus: session.redactionStatus,
  };
}
