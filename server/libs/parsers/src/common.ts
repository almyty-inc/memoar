import type { ContentBlock, ContentBlockKind, Turn } from "../../canonical/src/generated.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonLines(raw: Uint8Array): Record<string, unknown>[] | null {
  try {
    return Buffer.from(raw).toString("utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as unknown).filter(isRecord);
  } catch {
    return null;
  }
}

export function stringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

export function incrementUuid(uuid: string, amount: number): string {
  const compact = uuid.replaceAll("-", "");
  const incremented = (BigInt(`0x${compact}`) + BigInt(amount)).toString(16).padStart(32, "0");
  return `${incremented.slice(0, 8)}-${incremented.slice(8, 12)}-${incremented.slice(12, 16)}-${incremented.slice(16, 20)}-${incremented.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Blocks per turn that a fallback id scheme can hold without colliding. */
const FALLBACK_STRIDE = 4096;

/**
 * Distance the fallback ids sit from the seed.
 *
 * Turn ids in a real export are UUIDs allocated near the session's own id, and
 * their block ids are derived by adding small numbers to them. A fallback that
 * also counted up from the seed landed on those same values — a session id of
 * …140 and a turn id of …141 both minted …142. This moves the fallback range
 * far enough away that the two schemes cannot meet.
 */
const FALLBACK_BASE = 0x1000000;

/**
 * Id for a block that carries none of its own.
 *
 * Derived from the turn id when that is a UUID, which is the normal case. When
 * it is not, arithmetic on it throws, and an export whose ids happen to be
 * short strings would lose the entire conversation to a parse error rather than
 * one generated identifier. Those fall back to the seed, spaced by ordinal so
 * two turns cannot mint the same block id.
 */
export function derivedBlockId(turnId: string, index: number, seedId: string, ordinal: number): string {
  if (UUID.test(turnId)) return incrementUuid(turnId, index);
  return incrementUuid(seedId, FALLBACK_BASE + ordinal * FALLBACK_STRIDE + index);
}

const kinds = new Set<ContentBlockKind>(["text", "thinking", "tool_call", "tool_result", "diff", "artifact", "attachment", "system", "error"]);

export function parseBlock(value: unknown, fallbackId: string): ContentBlock | null {
  if (typeof value === "string") return { id: fallbackId, kind: "text", text: value };
  if (!isRecord(value)) return null;
  const kindValue = stringValue(value, "kind") ?? stringValue(value, "type") ?? "text";
  const kind = kinds.has(kindValue as ContentBlockKind) ? kindValue as ContentBlockKind : "text";
  const id = stringValue(value, "id") ?? fallbackId;
  const block: ContentBlock = {
    id,
    kind,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.callId === "string" ? { callId: value.callId } : {}),
    ...(typeof value.language === "string" ? { language: value.language } : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(typeof value.artifactRef === "string" ? { artifactRef: value.artifactRef } : {}),
    ...(isRecord(value.data) ? { data: value.data } : {}),
  };
  if (!kinds.has(kindValue as ContentBlockKind)) block.ext = { nativeKind: kindValue, native: value };
  return block;
}

export function withModelAndTokens(turn: Turn, model: string | undefined, input: number, output: number): Turn {
  if (turn.role !== "assistant") return turn;
  return {
    ...turn,
    ...(model ? { model } : {}),
    tokens: { input, output },
  };
}
