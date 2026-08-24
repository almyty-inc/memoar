import type { Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, parseBlock, stringValue, withModelAndTokens } from "./common.js";
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
  const id = stringValue(record, "id");
  if (!id) throw new Error(`row ${ordinal} lacks a message id`);
  const roleValue = stringValue(record, "role") ?? "user";
  const role = roleValue === "assistant" || roleValue === "tool" || roleValue === "system" ? roleValue : "user";
  const rawBlocks = Array.isArray(row.blocks) ? row.blocks : [];
  const blocks = rawBlocks.map((block, index) => parseBlock(block, incrementUuid(id, index + 1))).filter((block) => block !== null);
  return withModelAndTokens({
    id,
    ordinal,
    parentId: stringValue(record, "parentId"),
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
