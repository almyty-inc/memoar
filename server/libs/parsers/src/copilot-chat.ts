import type { ContentBlock, Session, Turn } from "../../canonical/src/generated.js";
import { derivedBlockId, epochToIso, incrementUuid, isRecord, stringValue } from "./common.js";
import type { SessionSeed } from "./types.js";

/**
 * VS Code Copilot Chat, which is a different store from the CLI's SQLite one.
 *
 * One panel is one envelope — `{version, requests[], sessionId, creationDate}`
 * — and a `request` holds both halves of an exchange: `message.text` is what
 * was typed and `response[]` is what came back, as the parts the renderer drew.
 * So a request becomes two turns, for the same reason the CLI's `turns` row
 * does: different authors, and the reply answers the question.
 *
 * Three layouts carry that same envelope and all three are read here:
 *
 *   - `chatSessions/<id>.json`, one whole envelope, the layout up to 2025;
 *   - `chatSessions/<id>.jsonl`, a `{kind:0, v:<envelope>}` snapshot line
 *     followed by `{kind:1, k:[path], v:value}` writes, what VS Code writes
 *     now — 18 of the 23 files on this machine are this one;
 *   - a bare array of envelopes, which is what the older `interactive.sessions`
 *     memento in `state.vscdb` holds. Capture never names it, but the populated
 *     sessions left on this machine are all in it, and reading it through this
 *     same code is what let the mapping below be checked against real requests
 *     rather than against a fixture written to agree with it.
 */

/** Panels VS Code opened and nobody used are envelopes too, with no requests. */
function isEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.requests) && typeof value.sessionId === "string";
}

export function chatEnvelopes(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) {
    const envelopes = value.filter(isEnvelope);
    return envelopes.length > 0 ? envelopes : null;
  }
  return isEnvelope(value) ? [value] : null;
}

/**
 * The `.jsonl` layout: a snapshot, then writes against it, replayed the way
 * VS Code's own reader does (`objectMutationLog.ts`, `ObjectMutationLog.read`):
 *
 *   - `{kind:0, v}` replaces the whole state, and VS Code writes one again
 *     whenever it compacts the log, so the last one wins;
 *   - `{kind:1, k, v}` sets the value at path `k`, creating the key;
 *   - `{kind:2, k, v?, i?}` cuts the array at `k` to length `i` when `i` is
 *     given, then appends `v`, which is how every new request arrives;
 *   - `{kind:3, k}` deletes the key at `k`.
 *
 * Reading only `kind:0` and `kind:1` lost every request a panel appended after
 * its first snapshot. A write whose parent path does not exist is skipped,
 * where VS Code would fail the whole file.
 */
export function chatEnvelopesFromLog(records: readonly Record<string, unknown>[]): Record<string, unknown>[] | null {
  let state: Record<string, unknown> | null = null;
  for (const record of records) {
    if (record.kind === 0) {
      state = isRecord(record.v) ? structuredClone(record.v) : null;
      continue;
    }
    if (!state || !Array.isArray(record.k)) continue;
    applyWrite(state, record);
  }
  return state && isEnvelope(state) ? [state] : null;
}

type Container = Record<string, unknown> | unknown[];

function child(container: Container, key: unknown): unknown {
  return Array.isArray(container) ? container[Number(key)] : container[String(key)];
}

function applyWrite(state: Record<string, unknown>, record: Record<string, unknown>): void {
  const path = record.k as unknown[];
  if (path.length === 0) return;
  let container: unknown = state;
  for (const segment of path.slice(0, -1)) {
    container = isRecord(container) || Array.isArray(container) ? child(container, segment) : undefined;
  }
  if (!isRecord(container) && !Array.isArray(container)) return;
  const target = container as Record<string, unknown>;
  const key = String(path.at(-1));
  if (record.kind === 1) target[key] = record.v;
  else if (record.kind === 3) delete target[key];
  else if (record.kind === 2) {
    const array = Array.isArray(target[key]) ? (target[key] as unknown[]) : [];
    if (typeof record.i === "number") array.length = Math.min(array.length, record.i);
    if (Array.isArray(record.v)) array.push(...(record.v as unknown[]));
    target[key] = array;
  }
}

/** `{$mid, fsPath, external, path, scheme}`, as VS Code serialises a URI. */
function uriPath(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return stringValue(value, "fsPath") ?? stringValue(value, "path") ?? stringValue(value, "external");
}

/** A `MarkdownString`, which is `{value, supportHtml, …}` rather than a string. */
function markdown(value: unknown): string | null {
  if (typeof value === "string") return value;
  return isRecord(value) ? stringValue(value, "value") : null;
}

/** The text of a `textEditGroup`, which is `edits: [[edit, …], …]`. */
function editText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flat()
    .map((edit) => (isRecord(edit) ? stringValue(edit, "text") : null))
    .filter((text): text is string => text !== null && text.length > 0)
    .join("\n");
}

/**
 * One response part as a block, or nothing.
 *
 * The kinds are the ones the real sessions on this machine actually contain:
 * a bare `MarkdownString` for prose, and `markdownVuln`, `progressMessage`,
 * `codeblockUri`, `textEditGroup` and `toolInvocationSerialized` beside it.
 * `progressMessage` is the status line the panel shows while it works and
 * `codeblockUri` only names the file for the code block already kept in the
 * markdown, so neither is content; every other kind that carries text keeps it,
 * and an unrecognised part with a `value` is still prose.
 */
function blockFrom(part: unknown, id: string): ContentBlock | null {
  if (!isRecord(part)) return typeof part === "string" && part.length > 0 ? { id, kind: "text", text: part } : null;
  const kind = stringValue(part, "kind");
  if (kind === "progressMessage" || kind === "codeblockUri") return null;
  if (kind === "toolInvocationSerialized") {
    // The message is what the panel showed. The tool, its call id, the
    // terminal command or file it acted on (`toolSpecificData`) and what came
    // back (`resultDetails`) sit beside it and were dropped.
    const text = stringValue(part, "pastTenseMessage") ?? markdown(part.pastTenseMessage)
      ?? stringValue(part, "invocationMessage") ?? markdown(part.invocationMessage);
    const name = stringValue(part, "toolId");
    const callId = stringValue(part, "toolCallId");
    const data: Record<string, unknown> = {};
    for (const key of ["invocationMessage", "toolSpecificData", "resultDetails", "isConfirmed", "isComplete"] as const) {
      if (part[key] !== undefined && part[key] !== null) data[key] = part[key];
    }
    if (!text && !name && Object.keys(data).length === 0) return null;
    return {
      id,
      kind: "tool_call",
      ...(text ? { text } : {}),
      ...(name ? { name } : {}),
      ...(callId ? { callId } : {}),
      ...(Object.keys(data).length > 0 ? { data } : {}),
    };
  }
  if (kind === "thinking") {
    const value = Array.isArray(part.value) ? (part.value as unknown[]).map(markdown).filter(Boolean).join("\n") : markdown(part.value);
    return value && value.trim().length > 0 ? { id, kind: "thinking", text: value } : null;
  }
  if (kind === "textEditGroup") {
    const text = editText(part.edits);
    if (!text) return null;
    const file = uriPath(part.uri);
    return { id, kind: "diff", text, ...(file ? { name: file } : {}) };
  }
  const text = markdown(part.value) ?? markdown(part.content);
  return text && text.trim().length > 0 ? { id, kind: "text", text } : null;
}

function blocksFrom(parts: unknown, turnId: string, seed: SessionSeed, ordinal: number): ContentBlock[] {
  if (!Array.isArray(parts)) return [];
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    const block = blockFrom(part, derivedBlockId(turnId, blocks.length + 1, seed.id, ordinal));
    if (block) blocks.push(block);
  }
  return blocks;
}

/** What was typed: `message.text`, or the parts it was assembled from. */
function promptText(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const text = stringValue(message, "text");
  if (text !== null && text.trim().length > 0) return text;
  if (!Array.isArray(message.parts)) return null;
  const joined = message.parts
    .map((part) => (isRecord(part) ? stringValue(part, "text") : null))
    .filter((value): value is string => value !== null)
    .join("");
  return joined.trim().length > 0 ? joined : null;
}

function turnsFrom(requests: readonly unknown[], seed: SessionSeed, fallbackCreatedAt: string): Turn[] {
  const turns: Turn[] = [];
  for (const [index, request] of requests.entries()) {
    if (!isRecord(request)) continue;
    const createdAt = epochToIso(request.timestamp, fallbackCreatedAt);
    const prompt = promptText(request.message);
    // Spaced by the request, not by the turn, so a request whose reply is empty
    // does not shift every id after it.
    const halves: [Turn["role"], number][] = [["user", index * 2 + 1], ["assistant", index * 2 + 2]];
    for (const [role, offset] of halves) {
      const ordinal = turns.length;
      const id = incrementUuid(seed.id, offset);
      const blocks: ContentBlock[] = role === "user"
        ? (prompt === null ? [] : [{ id: derivedBlockId(id, 1, seed.id, ordinal), kind: "text", text: prompt }])
        : blocksFrom(request.response, id, seed, ordinal);
      if (blocks.length === 0) continue;
      turns.push({ id, ordinal, parentId: turns.at(-1)?.id ?? null, role, createdAt, blocks });
    }
  }
  return turns.map((turn, ordinal) => ({ ...turn, ordinal }));
}

export function chatSessions(envelopes: readonly Record<string, unknown>[], seed: SessionSeed): Session[] {
  return envelopes.map((envelope, index): Session => {
    const sessionSeed: SessionSeed = { ...seed, id: index === 0 ? seed.id : incrementUuid(seed.id, index) };
    const title = stringValue(envelope, "customTitle");
    return {
      ...sessionSeed,
      source: { ...seed.source, nativeSessionId: String(envelope.sessionId) },
      ...(title ? { title } : {}),
      // A request carries no stamp of its own in most of these envelopes, so the
      // panel's creation is the only time the file offers.
      turns: turnsFrom(envelope.requests as unknown[], sessionSeed, epochToIso(envelope.creationDate, seed.createdAt)),
    };
  });
}
