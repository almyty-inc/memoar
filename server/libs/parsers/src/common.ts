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

/**
 * Converts an epoch stamp to ISO 8601, accepting both seconds and milliseconds.
 *
 * Several stores keep an integer here and differ on the unit, and a value read
 * in the wrong one lands in 1970 or in the far future rather than failing
 * visibly. Anything past this threshold cannot be seconds within any plausible
 * lifetime of a transcript.
 */
export function epochToIso(value: unknown, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const milliseconds = value > 100_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}

/** Blocks per turn that a fallback id scheme can hold without colliding. */
const FALLBACK_STRIDE = 4096;

/** Distance block ids sit from the session id, clear of any turn id. */
const FALLBACK_BASE = 0x1000000;

/**
 * Id for a block that carries none of its own.
 *
 * Always derived from the session id, never from the turn id. Native stores
 * allocate message ids sequentially, so `turnId + 1` frequently *is* the next
 * turn's id — a session whose turns were …144 and …145 minted a block …145.
 * Blocks live in their own range, spaced by ordinal so two turns cannot mint
 * the same id.
 */
export function derivedBlockId(_turnId: string, index: number, seedId: string, ordinal: number): string {
  return incrementUuid(seedId, FALLBACK_BASE + ordinal * FALLBACK_STRIDE + index);
}

/**
 * Vendor names for block kinds that mean something the canonical model already
 * has. Without these, a Claude Code transcript stored every one of its tool
 * calls as text carrying an ext.nativeKind note — 1,480 of them in a single
 * real session — so the archive rendered tool use as prose.
 */
const KIND_ALIASES: Readonly<Record<string, ContentBlockKind>> = {
  tool_use: "tool_call",
  toolRequest: "tool_call",
  toolResponse: "tool_result",
  tool_request: "tool_call",
  tool_response: "tool_result",
  toolu: "tool_call",
  function_call: "tool_call",
  tool_output: "tool_result",
  function_call_output: "tool_result",
  image: "attachment",
  input_text: "text",
  output_text: "text",
  thought: "thinking",
  reasoning: "thinking",
};

const kinds = new Set<ContentBlockKind>(["text", "thinking", "tool_call", "tool_result", "diff", "artifact", "attachment", "system", "error"]);

export function parseBlock(value: unknown, fallbackId: string): ContentBlock | null {
  if (typeof value === "string") return { id: fallbackId, kind: "text", text: value };
  if (!isRecord(value)) return null;
  const kindValue = stringValue(value, "kind") ?? stringValue(value, "type") ?? "text";
  const aliased = KIND_ALIASES[kindValue] ?? kindValue;
  const kind = kinds.has(aliased as ContentBlockKind) ? aliased as ContentBlockKind : "text";
  const id = stringValue(value, "id") ?? fallbackId;
  const block: ContentBlock = {
    id,
    kind,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.callId === "string" ? { callId: value.callId } : typeof value.tool_use_id === "string" ? { callId: value.tool_use_id } : typeof value.id === "string" && aliased === "tool_call" ? { callId: value.id } : {}),
    ...(typeof value.language === "string" ? { language: value.language } : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(typeof value.artifactRef === "string" ? { artifactRef: value.artifactRef } : {}),
    ...(isRecord(value.data) ? { data: value.data } : isRecord(value.input) ? { data: value.input } : {}),
  };
  if (!kinds.has(aliased as ContentBlockKind)) block.ext = { nativeKind: kindValue, native: value };
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
