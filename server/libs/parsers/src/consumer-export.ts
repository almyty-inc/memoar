import type { Session, Turn } from "../../canonical/src/generated.js";
import { readArchiveEntry } from "./archive.js";
import { incrementUuid, isRecord, stringValue } from "./common.js";
import { turnFromRow } from "./sqlite-rows.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

const CONVERSATIONS_ENTRY = "conversations.json";

/**
 * The consumer chat exports — Claude.ai, Gemini, Mistral, Perplexity — that the
 * contract fixtures describe. All four carry the same envelope
 * (`{ uuid, name, messages[] }`) with messages already in canonical block
 * shape, so one parser covers them and the source name is the only difference.
 *
 * Worth knowing before trusting this on a real download: those fixtures are
 * synthetic. A genuine Claude.ai export uses `chat_messages` with a `sender`
 * field, and a Gemini Takeout is a different structure again. This parser reads
 * what the contract specifies; real vendor archives need real samples and a
 * corrected fixture before these formats are offered in the UI.
 */
export class ConsumerExportParser implements VersionedParser {
  readonly versions = ["2026-08"] as const;

  constructor(readonly source: string) {}

  parse(request: ParseRequest): ParseResult {
    try {
      const decoded = JSON.parse(readArchiveEntry(request.raw, CONVERSATIONS_ENTRY)) as unknown;
      const conversations = Array.isArray(decoded) ? decoded : [decoded];
      const sessions: Session[] = [];
      for (const [index, conversation] of conversations.entries()) {
        if (!isRecord(conversation)) continue;
        const session = this.toSession(conversation, index, request);
        if (session) sessions.push(session);
      }
      if (sessions.length === 0) {
        return { kind: "unknown", diagnostic: `${this.source} contained no conversations with messages`, raw: request.raw };
      }
      return { kind: "parsed", parser: `${this.source}:2026-08:0.2.0`, sessions };
    } catch (error) {
      return {
        kind: "unknown",
        diagnostic: `${this.source} decode failed: ${error instanceof Error ? error.message : String(error)}`,
        raw: request.raw,
      };
    }
  }

  private toSession(conversation: Record<string, unknown>, index: number, request: ParseRequest): Session | null {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (messages.length === 0) return null;
    const seed = request.seed;

    const turns = messages.map((message, ordinal): Turn => {
      if (!isRecord(message)) throw new Error(`${this.source} message ${ordinal} is not an object`);
      return turnFromRow({
        id: stringValue(message, "id") ?? undefined,
        parentId: stringValue(message, "parentId"),
        role: stringValue(message, "role") ?? undefined,
        createdAt: stringValue(message, "createdAt") ?? undefined,
        blocks: message.blocks,
      }, ordinal, seed);
    });

    const title = stringValue(conversation, "name");
    return {
      ...seed,
      // Several conversations in one archive must not collide on the seed's id.
      id: index === 0 ? seed.id : incrementUuid(seed.id, index),
      ...(title ? { title } : {}),
      turns,
    };
  }
}
