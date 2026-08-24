import type { Session, Turn } from "../../canonical/src/generated.js";
import { incrementUuid } from "./common.js";
import { parseJsonColumn, turnFromRow } from "./sqlite-rows.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

export class CrushV1Parser implements VersionedParser {
  readonly source = "crush";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    if (!isSqliteBytes(request.raw)) {
      return { kind: "unknown", diagnostic: "crush v1 requires a native SQLite session database", raw: request.raw };
    }
    try {
      const sessions = withSqlite(request.raw, (database) => {
        const sessionRows = database
          .prepare("SELECT id, title FROM sessions ORDER BY id")
          .all() as { id: string; title: string | null }[];
        if (!sessionRows.length) throw new Error("crush v1 database has no sessions");
        const messagesFor = database
          .prepare("SELECT id, parent_id, role, created_at, parts FROM messages WHERE session_id = ? ORDER BY ordinal");
        return sessionRows.map((sessionRow, sessionIndex): Session => {
          const rows = messagesFor.all(sessionRow.id) as { id: string; parent_id: string | null; role: string; created_at: string; parts: string | Uint8Array }[];
          const turns = rows.map((row, ordinal): Turn => turnFromRow({
            id: row.id,
            parentId: row.parent_id,
            role: row.role,
            createdAt: row.created_at,
            blocks: parseJsonColumn(row.parts, `messages.parts row ${ordinal}`),
          }, ordinal, request.seed));
          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId: sessionRow.id },
            ...(sessionRow.title ? { title: sessionRow.title } : {}),
            turns,
          };
        });
      });
      return { kind: "parsed", parser: "crush:v1:0.2.0", sessions };
    } catch (error) {
      return { kind: "unknown", diagnostic: `crush v1 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`, raw: request.raw };
    }
  }
}
