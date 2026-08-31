import type { Session, Turn } from "../../canonical/src/generated.js";
import { epochToIso, incrementUuid } from "./common.js";
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
        // Columns per crush's own initial migration: messages carry no parent
        // and no ordinal, and times are Unix milliseconds rather than text.
        // Selecting parent_id and ordering by ordinal failed on a real database
        // before either row could be read.
        const sessionRows = database
          .prepare("SELECT id, title FROM sessions ORDER BY created_at, id")
          .all() as unknown as { id: string; title: string | null }[];
        if (!sessionRows.length) throw new Error("database has no sessions");
        const messagesFor = database
          .prepare("SELECT id, role, parts, model, created_at FROM messages WHERE session_id = ? ORDER BY created_at, id");
        return sessionRows.map((sessionRow, sessionIndex): Session => {
          const rows = messagesFor.all(sessionRow.id) as unknown as { id: string; role: string; parts: string | Uint8Array; model: string | null; created_at: number }[];
          let previousId: string | null = null;
          const turns = rows.map((row, ordinal): Turn => {
            const turn = turnFromRow({
              id: row.id,
              // Crush stores a flat conversation, so the order is the chain.
              parentId: previousId,
              role: row.role,
              createdAt: epochToIso(row.created_at, request.seed.createdAt),
              blocks: parseJsonColumn(row.parts, `messages.parts row ${ordinal}`),
            }, ordinal, request.seed);
            previousId = row.id;
            return row.model ? { ...turn, model: row.model } : turn;
          });
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
