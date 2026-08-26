import type { Session, Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, stringValue } from "./common.js";
import { turnFromRow } from "./sqlite-rows.js";
import type { SessionSeed } from "./types.js";

/**
 * A conversation as every agent in this family stores one: an id, a title, and
 * an ordered list of messages that already carry their own ids, roles and
 * parent links.
 */
export interface NativeConversation {
  readonly id: string | null;
  readonly title: string | null;
  readonly messages: readonly unknown[];
}

/**
 * Reads `{ id, role, at | createdAt, parentId, parts | blocks }` messages, the
 * shape shared by Warp, Windsurf, Amp, Kilo, Roo and pi-agent. They differ in
 * where the conversation list is stored — a SQLite column, a JSON key, a stream
 * of events — not in what a message looks like, so the differences live in each
 * parser and the message reading lives here once.
 */
export function conversationToSession(
  conversation: NativeConversation,
  index: number,
  seed: SessionSeed,
  fallbackId: string,
): Session {
  const turns = conversation.messages.map((message, ordinal): Turn => {
    if (!isRecord(message)) throw new Error(`message ${ordinal} is not an object`);
    return turnFromRow({
      id: stringValue(message, "id") ?? undefined,
      parentId: stringValue(message, "parentId"),
      role: stringValue(message, "role") ?? undefined,
      // `at` and `createdAt` are the same field under two names.
      createdAt: stringValue(message, "at") ?? stringValue(message, "createdAt") ?? undefined,
      blocks: Array.isArray(message.parts) ? message.parts : message.blocks,
    }, ordinal, seed);
  });

  return {
    ...seed,
    // Several conversations in one file must not collide on the seed's id.
    id: index === 0 ? seed.id : incrementUuid(seed.id, index),
    source: { ...seed.source, nativeSessionId: conversation.id ?? fallbackId },
    ...(conversation.title ? { title: conversation.title } : {}),
    turns,
  };
}

/** Reads the common envelope out of a decoded JSON object. */
export function readConversation(value: unknown, messagesKey: string, idKey = "id"): NativeConversation | null {
  if (!isRecord(value)) return null;
  const messages = value[messagesKey];
  if (!Array.isArray(messages)) return null;
  return {
    id: stringValue(value, idKey),
    title: stringValue(value, "title"),
    messages,
  };
}
