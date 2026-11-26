import type { DatabaseSync } from "node:sqlite";
import type { TokenTotals } from "../../canonical/src/generated.js";
import { isRecord, stringValue } from "./common.js";
import { tokenTotals } from "./tokens.js";

/**
 * What Cursor 3.x keeps about a conversation outside `composerData`.
 *
 * None of this was checked against a Cursor install: Cursor is not on the
 * machine this was written on. It follows the community readers that are run
 * against real stores, chiefly `getagentseal/codeburn`
 * (`src/providers/cursor.ts`), which reads `modelInfo.modelName` and
 * `createdAt` off each bubble and the `composer.composerHeaders` index that
 * newer builds write in place of `composer.composerData`.
 */

/** `composer.composerHeaders` in `ItemTable`: `{allComposers: [{composerId, name}]}`. */
export function composerNames(database: DatabaseSync): Map<string, string> {
  const names = new Map<string, string>();
  const hasItems = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'").get();
  if (!hasItems) return names;
  const rows = database
    .prepare("SELECT value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData')")
    .all() as { value: unknown }[];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof row.value === "string" ? row.value : Buffer.from(row.value as Uint8Array).toString("utf8"));
    } catch {
      continue;
    }
    const all = isRecord(parsed) && Array.isArray(parsed.allComposers) ? parsed.allComposers : [];
    for (const header of all) {
      if (!isRecord(header)) continue;
      const id = stringValue(header, "composerId");
      const name = stringValue(header, "name");
      if (id && name && !names.has(id)) names.set(id, name);
    }
  }
  return names;
}

/** A bubble's own `createdAt`: an ISO string in 3.x, epoch milliseconds before. */
export function bubbleTime(value: unknown): string | null {
  const date = typeof value === "string" ? new Date(value)
    : typeof value === "number" && value > 0 ? new Date(value > 100_000_000_000 ? value : value * 1000)
      : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : null;
}

/** `modelInfo.modelName`, which assistant bubbles carry and user bubbles do not. */
export function bubbleModel(bubble: Record<string, unknown>): string | undefined {
  const info = isRecord(bubble.modelInfo) ? bubble.modelInfo : null;
  const name = info ? stringValue(info, "modelName") : null;
  return name && name !== "default" ? name : undefined;
}

/**
 * `tokenCount: {inputTokens, outputTokens}`, which Cursor writes on a bubble,
 * often as zeros. Cursor does not say whether its input count includes cached
 * tokens, so it is read as input and nothing is put under the cache fields.
 * Not checked against a Cursor install: none is on the machine this was
 * written on, and the shape is the one the community exporters read.
 */
export function bubbleTokens(bubble: Record<string, unknown>): TokenTotals {
  const count = isRecord(bubble.tokenCount) ? bubble.tokenCount : {};
  return tokenTotals(count.inputTokens, count.outputTokens);
}

/**
 * Headers for a composer whose `fullConversationHeadersOnly` is missing or
 * empty, made from its own bubbles in the order they were written.
 */
export function unindexedHeaders(bubbles: ReadonlyMap<string, Record<string, unknown>>, composerId: string): Record<string, unknown>[] {
  const prefix = `bubbleId:${composerId}:`;
  return [...bubbles.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, bubble]) => ({ bubbleId: key.slice(prefix.length), type: bubble.type, at: bubbleTime(bubble.createdAt) ?? "" }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map(({ bubbleId, type }) => ({ bubbleId, type }));
}
