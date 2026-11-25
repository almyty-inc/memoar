import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { unzipSync } from "fflate";

/** One string a native store holds, and where: `<record label>.<key path>`. */
export interface NativeString {
  path: string;
  value: string;
}

/** Shorter than this is a flag, an enum or a word, not something a reader would miss. */
export const MIN_LENGTH = 16;

/**
 * Keys whose values identify or time something rather than say it, and the
 * opaque signature Anthropic attaches to thinking. These are left out by name,
 * never by guessing at what a value looks like.
 */
const NOT_CONTENT_KEYS = new Set([
  "id", "uuid", "parentUuid", "leafUuid", "sessionId", "session_id", "messageId", "message_id", "requestId", "promptId",
  "tool_use_id", "toolUseID", "call_id", "callID", "toolCallId", "tool_call_id", "callId", "bubbleId", "composerId",
  "timestamp", "created_at", "createdAt", "updated_at", "time", "signature", "parentID", "sessionID", "messageID",
  "agentId", "thread_id", "turn_id", "root_turn_id", "window_id", "cwd", "version", "cli_version", "gitBranch", "slug",
  // Type tags: they name a shape, which the canonical block kind replaces.
  "type", "kind", "role", "status", "content_type", "subtype", "source",
]);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

function isJsonText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every string in a JSON value, with its key path. JSON kept inside a string,
 * which is how most stores keep tool arguments, is descended into rather than
 * counted whole.
 */
export function stringsOf(value: unknown, path: string, into: NativeString[] = [], key = ""): NativeString[] {
  if (typeof value === "string") {
    const nested = isJsonText(value);
    if (nested !== undefined) return stringsOf(nested, path, into);
    if (value.length >= MIN_LENGTH && !NOT_CONTENT_KEYS.has(key) && !ISO_TIME.test(value)) into.push({ path, value });
    return into;
  }
  if (Array.isArray(value)) {
    (value as unknown[]).forEach((item, index) => stringsOf(item, `${path}[${index}]`, into, key));
    return into;
  }
  if (value !== null && typeof value === "object") {
    for (const [child, item] of Object.entries(value as Record<string, unknown>)) stringsOf(item, `${path}.${child}`, into, child);
  }
  return into;
}

/** A label naming what kind of line a JSONL record is, so drops can be declared per kind. */
function recordLabel(record: Record<string, unknown>): string {
  const tag = typeof record.type === "string" ? record.type : typeof record.kind === "string" ? record.kind : "";
  const parts = [`type=${tag}`];
  const inner = (record.attachment ?? record.payload) as Record<string, unknown> | undefined;
  if (inner && typeof inner === "object" && typeof inner.type === "string") parts.push(`${record.attachment ? "attachment" : "payload"}=${inner.type}`);
  if (typeof record.subtype === "string") parts.push(`subtype=${record.subtype}`);
  return `[${parts.join(",")}]`;
}

function sqliteStrings(raw: Uint8Array): NativeString[] {
  const directory = mkdtempSync(join(tmpdir(), "memoar-fidelity-"));
  const path = join(directory, "native.sqlite3");
  writeFileSync(path, raw);
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    const into: NativeString[] = [];
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of tables) {
      for (const row of database.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
        for (const [column, cell] of Object.entries(row)) {
          let value: unknown = cell;
          if (cell instanceof Uint8Array) {
            const bytes = Buffer.from(cell);
            value = (row.data_type === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8");
          }
          stringsOf(value, `[${name}].${column}`, into, column);
        }
      }
    }
    database.close();
    return into;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Every string in a fixture's native input, structure-blind except for the labels. */
export function nativeStrings(raw: Uint8Array): NativeString[] {
  const bytes = Buffer.from(raw);
  if (bytes.subarray(0, 16).toString("latin1").startsWith("SQLite format 3")) return sqliteStrings(raw);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return Object.entries(unzipSync(new Uint8Array(raw))).flatMap(([name, entry]) => stringsOf(Buffer.from(entry).toString("utf8"), `[${name}]`));
  }
  const text = bytes.toString("utf8");
  const whole = isJsonText(text);
  if (whole !== undefined) return stringsOf(whole, "[document]");
  return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const record = isJsonText(line) as Record<string, unknown> | undefined;
    return record ? stringsOf(record, recordLabel(record)) : [];
  });
}

/** Every string leaf of a parsed result, as one searchable haystack. */
export function haystackOf(value: unknown): string {
  const leaves: string[] = [];
  const walk = (item: unknown): void => {
    if (typeof item === "string") {
      leaves.push(item);
      // A JSON string kept whole holds its inner strings escaped.
      const nested = isJsonText(item);
      if (nested !== undefined) walk(nested);
    }
    else if (Array.isArray(item)) (item as unknown[]).forEach(walk);
    else if (item !== null && typeof item === "object") Object.values(item as Record<string, unknown>).forEach(walk);
  };
  walk(value);
  return leaves.join("\u0001");
}
