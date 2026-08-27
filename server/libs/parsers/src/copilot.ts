import type { Session, Turn } from "../../canonical/src/generated.js";
import { derivedBlockId, incrementUuid } from "./common.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

interface TurnRow {
  id: number;
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string | null;
}

/**
 * GitHub Copilot CLI keeps a session row and a table of exchanges, where one
 * row holds both what the user asked and what the model replied.
 *
 * The canonical model records those as two turns, because they have different
 * authors and the reply answers the question — collapsing them into one would
 * lose the parent link that makes a transcript a conversation.
 *
 * The schema here was read off an installed Copilot CLI, but that install had
 * no recorded exchanges, so unlike opencode this parser has not been run
 * against a real transcript. The shape is right; the mapping of a populated
 * session deserves checking against one when a real session exists.
 */
export class CopilotV1Parser implements VersionedParser {
  readonly source = "copilot";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    if (!isSqliteBytes(request.raw)) {
      return { kind: "unknown", diagnostic: "copilot v1 requires a native SQLite session store", raw: request.raw };
    }
    try {
      const sessions = withSqlite(request.raw, (database) => {
        const sessionRows = database
          .prepare("SELECT id, cwd, summary, created_at FROM sessions ORDER BY created_at, id")
          .all() as unknown as { id: string; cwd: string | null; summary: string | null; created_at: string | null }[];
        if (sessionRows.length === 0) throw new Error("session store has no sessions");

        const turnsFor = database
          .prepare("SELECT id, turn_index, user_message, assistant_response, timestamp FROM turns WHERE session_id = ? ORDER BY turn_index");

        return sessionRows.map((sessionRow, sessionIndex): Session => {
          const rows = turnsFor.all(sessionRow.id) as unknown as TurnRow[];
          const turns: Turn[] = [];

          for (const row of rows) {
            const createdAt = row.timestamp ?? request.seed.createdAt;
            const exchange: [string | null, Turn["role"]][] = [
              [row.user_message, "user"],
              [row.assistant_response, "assistant"],
            ];
            for (const [text, role] of exchange) {
              if (text === null || text.length === 0) continue;
              const ordinal = turns.length;
              const id = incrementUuid(request.seed.id, row.turn_index * 2 + (role === "assistant" ? 2 : 1));
              turns.push({
                id,
                ordinal,
                // The reply answers the question in the same row; anything else
                // starts from the previous exchange.
                parentId: turns.at(-1)?.id ?? null,
                role,
                createdAt,
                blocks: [{ id: derivedBlockId(id, 1, request.seed.id, ordinal), kind: "text", text }],
              });
            }
          }

          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId: sessionRow.id },
            ...(sessionRow.summary ? { title: sessionRow.summary } : {}),
            ...(sessionRow.cwd ? { workspace: { ...request.seed.workspace, path: sessionRow.cwd } } : {}),
            turns,
          };
        });
      });
      return { kind: "parsed", parser: "copilot:v1:0.2.0", sessions };
    } catch (error) {
      return {
        kind: "unknown",
        diagnostic: `copilot v1 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`,
        raw: request.raw,
      };
    }
  }
}
