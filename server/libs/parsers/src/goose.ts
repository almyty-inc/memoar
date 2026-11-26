import type { Session, Turn } from "../../canonical/src/generated.js";
import { epochToIso, incrementUuid, isRecord, sessionModels, stringValue } from "./common.js";

/** `model_name` of the session's `ModelConfig` (`crates/goose/src/model_config.rs`). */
function configuredModel(json: string | null | undefined): string | null {
  if (!json) return null;
  try {
    const config: unknown = JSON.parse(json);
    return isRecord(config) ? stringValue(config, "model_name") : null;
  } catch {
    return null;
  }
}
import { goosePart } from "./native-parts.js";
import { parseJsonColumn, turnFromRow } from "./sqlite-rows.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";
import { parserVersion } from "./versions.js";

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
          // Every column, so `model_config_json`, which newer goose writes and
          // older goose does not have, is read where it exists.
          .prepare("SELECT * FROM sessions ORDER BY created_at, id")
          .all() as unknown as { id: string; description: string | null; name: string | null; working_dir: string | null; model_config_json?: string | null }[];
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
            }, ordinal, request.seed, goosePart);
            previousId = id;
            return turn;
          });
          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId: sessionRow.id },
            ...(sessionRow.description || sessionRow.name ? { title: sessionRow.description || sessionRow.name! } : {}),
            ...(sessionRow.working_dir ? { workspace: { ...request.seed.workspace, path: sessionRow.working_dir } } : {}),
            models: sessionModels(request.seed.models, turns, configuredModel(sessionRow.model_config_json)),
            turns,
          };
        });
      });
      return { kind: "parsed", parser: parserVersion(this.source), sessions };
    } catch (error) {
      return { kind: "unknown", diagnostic: `goose v1 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`, raw: request.raw };
    }
  }
}
