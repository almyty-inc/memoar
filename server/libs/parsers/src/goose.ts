import type { Session, Turn } from "../../canonical/src/generated.js";
import { epochToIso, incrementUuid } from "./common.js";
import { parseJsonColumn, turnFromRow } from "./sqlite-rows.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

export class GooseV1Parser implements VersionedParser {
  readonly source = "goose";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    if (!isSqliteBytes(request.raw)) {
      return { kind: "unknown", diagnostic: "goose v1 requires a native SQLite session database", raw: request.raw };
    }
    try {
      const sessions = withSqlite(request.raw, (database) => {
        // Columns per goose's own session_manager: content lives in
        // content_json, time in created_timestamp, and there is no parent_id
        // and no ordinal. Four of the five columns this selected did not exist,
        // so a real database failed before a row could be read. The ordering is
        // the one goose itself uses to replay a conversation.
        const sessionRows = database
          .prepare("SELECT id, description, name, working_dir FROM sessions ORDER BY created_at, id")
          .all() as unknown as { id: string; description: string | null; name: string | null; working_dir: string | null }[];
        if (!sessionRows.length) throw new Error("database has no sessions");
        const messagesFor = database
          .prepare("SELECT message_id, role, content_json, created_timestamp FROM messages WHERE session_id = ? ORDER BY created_timestamp, id");
        return sessionRows.map((sessionRow, sessionIndex): Session => {
          const rows = messagesFor.all(sessionRow.id) as unknown as { message_id: string | null; role: string; content_json: string | Uint8Array; created_timestamp: number }[];
          let previousId: string | null = null;
          const turns = rows.map((row, ordinal): Turn => {
            const id = row.message_id ?? incrementUuid(request.seed.id, ordinal + 1);
            const turn = turnFromRow({
              id,
              // goose stores a flat conversation, so the order is the chain.
              parentId: previousId,
              role: row.role,
              createdAt: epochToIso(row.created_timestamp, request.seed.createdAt),
              blocks: parseJsonColumn(row.content_json, `messages.content_json row ${ordinal}`),
            }, ordinal, request.seed);
            previousId = id;
            return turn;
          });
          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId: sessionRow.id },
            ...(sessionRow.description || sessionRow.name ? { title: sessionRow.description || sessionRow.name! } : {}),
            ...(sessionRow.working_dir ? { workspace: { ...request.seed.workspace, path: sessionRow.working_dir } } : {}),
            turns,
          };
        });
      });
      return { kind: "parsed", parser: "goose:v1:0.2.0", sessions };
    } catch (error) {
      return { kind: "unknown", diagnostic: `goose v1 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`, raw: request.raw };
    }
  }
}
