import type { Session } from "../../canonical/src/generated.js";
import { isRecord } from "./common.js";
import { conversationToSession, readConversation, type NativeConversation } from "./conversation-list.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

function parsed(source: string, sessions: Session[], raw: Uint8Array): ParseResult {
  if (sessions.length === 0) {
    return { kind: "unknown", diagnostic: `${source} held no conversations`, raw };
  }
  return { kind: "parsed", parser: `${source}:v1:0.2.0`, sessions };
}

function failed(source: string, error: unknown, raw: Uint8Array): ParseResult {
  return {
    kind: "unknown",
    diagnostic: `${source} decode failed: ${error instanceof Error ? error.message : String(error)}`,
    raw,
  };
}

function build(source: string, conversations: readonly NativeConversation[], request: ParseRequest): ParseResult {
  const sessions = conversations.map((conversation, index) =>
    conversationToSession(conversation, index, request.seed, `${source}-${index + 1}`));
  return parsed(source, sessions, request.raw);
}

/** Warp keeps one JSON document per conversation in a SQLite column. */
export class WarpV1Parser implements VersionedParser {
  readonly source = "warp";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    if (!isSqliteBytes(request.raw)) {
      return { kind: "unknown", diagnostic: "warp v1 requires a native SQLite database", raw: request.raw };
    }
    try {
      const conversations = withSqlite(request.raw, (database) => {
        const rows = database
          .prepare("SELECT conversation_data FROM agent_conversations ORDER BY conversation_id")
          .all() as { conversation_data: string }[];
        return rows
          .map((row) => readConversation(JSON.parse(row.conversation_data) as unknown, "messages"))
          .filter((conversation): conversation is NativeConversation => conversation !== null);
      });
      return build(this.source, conversations, request);
    } catch (error) {
      return failed("warp v1", error, request.raw);
    }
  }
}

/**
 * Windsurf stores its state in the editor's own key/value database, so the
 * conversations sit inside one JSON value rather than in a table of their own.
 */
export class WindsurfV1Parser implements VersionedParser {
  readonly source = "windsurf";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    if (!isSqliteBytes(request.raw)) {
      return { kind: "unknown", diagnostic: "windsurf v1 requires a native SQLite database", raw: request.raw };
    }
    try {
      const conversations = withSqlite(request.raw, (database) => {
        const row = database
          .prepare("SELECT value FROM ItemTable WHERE key = ?")
          .get("windsurf.cascadeState") as { value: string | Uint8Array } | undefined;
        if (!row) throw new Error("no windsurf.cascadeState entry");
        const text = typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
        const state = JSON.parse(text) as unknown;
        const list = isRecord(state) && Array.isArray(state.conversations) ? state.conversations : [];
        return list
          .map((entry) => readConversation(entry, "messages"))
          .filter((conversation): conversation is NativeConversation => conversation !== null);
      });
      return build(this.source, conversations, request);
    } catch (error) {
      return failed("windsurf v1", error, request.raw);
    }
  }
}

/** Amp groups conversations under `threads`. */
export class AmpV1Parser implements VersionedParser {
  readonly source = "amp";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    try {
      const input = JSON.parse(Buffer.from(request.raw).toString("utf8")) as unknown;
      const threads = isRecord(input) && Array.isArray(input.threads) ? input.threads : [];
      const conversations = threads
        .map((thread) => readConversation(thread, "messages"))
        .filter((conversation): conversation is NativeConversation => conversation !== null);
      return build(this.source, conversations, request);
    } catch (error) {
      return failed("amp v1", error, request.raw);
    }
  }
}
