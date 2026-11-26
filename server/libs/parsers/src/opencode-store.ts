import type { DatabaseSync } from "node:sqlite";
import { isRecord, stringValue } from "./common.js";

/**
 * One opencode message as the turn mapping reads it, from either generation of
 * the schema: `data` is the v1 message record and `parts` its v1 part records.
 */
export interface StoredMessage {
  id: string;
  timeCreated: number;
  data: Record<string, unknown>;
  parts: { id: string; data: Record<string, unknown> }[];
}

export interface StoredSession {
  id: string;
  title: string | null;
  directory: string | null;
  /** The model the session was last set to, `{id, providerID}` in a JSON column. */
  model: string | null;
  messages: StoredMessage[];
}

type Row = Record<string, unknown>;

function tables(database: DatabaseSync): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[];
  return new Set(rows.map((row) => String(row.name)));
}

function columns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name)));
}

function json(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function modelOf(value: unknown): string | null {
  const record = typeof value === "string" ? json(value) : isRecord(value) ? value : null;
  return record ? stringValue(record, "id") : null;
}

/**
 * A v2 content item as the v1 part it stands for.
 *
 * opencode's v2 `session_message.data.content` and `session_part.data` hold
 * `{type:"text"|"reasoning", text}` and `{type:"tool", id, name, state:{input,
 * content:[{type:"text", text}], metadata, status}}`, where v1 kept a tool's
 * output as `state.output` and its name as `tool`.
 */
function partFromContent(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type !== "tool") return item;
  const state = isRecord(item.state) ? item.state : {};
  const content = Array.isArray(state.content) ? state.content : [];
  const output = content
    .map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
  return {
    type: "tool",
    tool: item.name,
    callID: item.id,
    state: { ...state, ...(output ? { output } : {}) },
  };
}

/** A v2 message in the v1 record shape, with its content as parts. */
function fromV2(row: Row, partRows: Row[]): StoredMessage {
  const id = String(row.id);
  const data = json(row.data) ?? {};
  const role = stringValue(row, "type") ?? "user";
  const model = isRecord(data.model) ? data.model : null;
  const items = partRows.length > 0
    ? partRows.map((part) => json(part.data) ?? {})
    : Array.isArray(data.content) ? data.content.filter(isRecord) : [];
  const text = stringValue(data, "text");
  const parts = [...(text ? [{ type: "text", text }] : []), ...items.map(partFromContent)];
  return {
    id,
    timeCreated: Number(row.time_created),
    data: {
      role,
      ...(model ? { modelID: model.id, providerID: model.providerID } : {}),
      ...(isRecord(data.tokens) ? { tokens: data.tokens } : {}),
    },
    parts: parts.map((part, index) => ({ id: `${id}:${index}`, data: part })),
  };
}

function v1Messages(database: DatabaseSync, sessionId: string): StoredMessage[] {
  const partRows = database
    .prepare("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id")
    .all(sessionId) as Row[];
  const partsByMessage = new Map<string, StoredMessage["parts"]>();
  for (const part of partRows) {
    const bucket = partsByMessage.get(String(part.message_id)) ?? [];
    bucket.push({ id: String(part.id), data: json(part.data) ?? {} });
    partsByMessage.set(String(part.message_id), bucket);
  }
  return (database
    .prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
    .all(sessionId) as Row[])
    .map((row) => ({
      id: String(row.id),
      timeCreated: Number(row.time_created),
      data: json(row.data) ?? {},
      parts: partsByMessage.get(String(row.id)) ?? [],
    }));
}

function v2Messages(database: DatabaseSync, sessionId: string, hasParts: boolean): StoredMessage[] {
  const partsFor = hasParts
    ? database.prepare("SELECT data FROM session_part WHERE message_id = ? ORDER BY ordinal")
    : null;
  return (database
    .prepare("SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY time_created, id")
    .all(sessionId) as Row[])
    .map((row) => fromV2(row, partsFor ? (partsFor.all(String(row.id)) as Row[]) : []));
}

/**
 * Every session in an opencode-schema database, whichever tables hold it.
 *
 * opencode is moving from `session`/`message`/`part` to
 * `session_v2`/`session_message`/`session_part`
 * (`packages/core/src/session/sql.ts`), and a database mid-migration holds
 * both: on the machine checked on 2026-11-26 the one session was in both, 47
 * messages were in both and one system message only in `session_message`.
 * Kilo Code, rebuilt on opencode, keeps v1 `session` with a `session_message`
 * table beside it. So a session is read from v1 where v1 has it, and every
 * message v1 lacks is taken from v2, by id.
 */
export function storedSessions(database: DatabaseSync): StoredSession[] {
  const present = tables(database);
  const hasV1 = present.has("session") && present.has("message") && present.has("part");
  const hasV2Messages = present.has("session_message");
  const hasV2Parts = present.has("session_part");
  const sessions = new Map<string, StoredSession>();
  const read = (table: string): void => {
    const hasModel = columns(database, table).has("model");
    const rows = database
      .prepare(`SELECT id, title, directory${hasModel ? ", model" : ""} FROM ${table} ORDER BY id`)
      .all() as Row[];
    for (const row of rows) {
      const id = String(row.id);
      if (sessions.has(id)) continue;
      sessions.set(id, {
        id,
        title: stringValue(row, "title"),
        directory: stringValue(row, "directory"),
        model: modelOf(row.model),
        messages: [],
      });
    }
  };
  if (hasV1) read("session");
  if (present.has("session_v2") && hasV2Messages) read("session_v2");

  for (const session of sessions.values()) {
    const v1 = hasV1 ? v1Messages(database, session.id) : [];
    const known = new Set(v1.map((message) => message.id));
    const v2 = hasV2Messages ? v2Messages(database, session.id, hasV2Parts).filter((message) => !known.has(message.id)) : [];
    session.messages = [...v1, ...v2].sort((a, b) => a.timeCreated - b.timeCreated || byteOrder(a.id, b.id));
  }
  return [...sessions.values()].sort((a, b) => byteOrder(a.id, b.id));
}

/** The order SQLite's `ORDER BY id` gives, which the session numbering follows. */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
