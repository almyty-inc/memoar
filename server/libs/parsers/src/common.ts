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
