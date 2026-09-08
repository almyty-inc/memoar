import type { Turn } from "../../canonical/src/generated.js";
import { derivedBlockId, isRecord, mapParent, parseBlock, stringValue, turnId, withModelAndTokens } from "./common.js";
import type { SessionSeed } from "./types.js";

interface RowShape {
  id?: string | undefined;
  parentId?: string | null | undefined;
  role?: string | undefined;
  createdAt?: string | undefined;
  blocks?: unknown;
}

export function turnFromRow(row: RowShape, ordinal: number, seed: SessionSeed): Turn {
  const record = row as Record<string, unknown>;
  const nativeId = stringValue(record, "id");
  if (!nativeId) throw new Error(`row ${ordinal} lacks a message id`);
  // Turn ids are a uuid column. Several of the stores behind this function
  // number their messages some other way, and passing one straight through had
  // the database refuse the whole session after it had parsed perfectly.
  const id = turnId(nativeId, seed.id);
  const roleValue = stringValue(record, "role") ?? "user";
  const role = roleValue === "assistant" || roleValue === "tool" || roleValue === "system" ? roleValue : "user";
  const rawBlocks = Array.isArray(row.blocks) ? row.blocks : [];
  const blocks = rawBlocks.map((block, index) => parseBlock(block, derivedBlockId(id, index + 1, seed.id, ordinal))).filter((block) => block !== null);
  return withModelAndTokens({
    id,
    ordinal,
    parentId: mapParent(stringValue(record, "parentId"), seed.id),
    role,
    createdAt: stringValue(record, "createdAt") ?? seed.createdAt,
    blocks,
  }, seed.models[0], seed.tokenTotals.input, seed.tokenTotals.output);
}

export function parseJsonColumn(value: unknown, label: string): unknown {
  const text = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : null;
  if (text === null) throw new Error(`${label} is neither text nor blob`);
  const parsed = JSON.parse(text) as unknown;
  return parsed;
}

export function ensureRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not a JSON object`);
  return value;
}
