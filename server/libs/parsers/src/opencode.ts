import type { ContentBlock, Session, Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, stringValue } from "./common.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

interface PartRow {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
}

interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}

function turnRole(role: string | null): Turn["role"] {
  return role === "assistant" || role === "tool" || role === "system" ? role : "user";
}

/**
 * Maps one opencode part onto a canonical block.
 *
 * step-start and step-finish carry no content — they bracket the model's work
 * and exist for the UI's progress display — so they produce nothing rather than
 * empty blocks that would clutter every transcript.
 */
function partToBlock(part: Record<string, unknown>, id: string): ContentBlock | null {
  const type = stringValue(part, "type");
  if (type === "text") {
    const text = stringValue(part, "text");
    return text === null || text.length === 0 ? null : { id, kind: "text", text };
  }
  if (type === "reasoning") {
    const text = stringValue(part, "text");
    return text === null || text.length === 0 ? null : { id, kind: "thinking", text };
  }
  if (type === "tool") {
    const state = isRecord(part.state) ? part.state : {};
    return {
      id,
      kind: "tool_call",
      name: stringValue(part, "tool") ?? "tool",
      callId: stringValue(part, "callID") ?? id,
      data: isRecord(state.input) ? state.input : {},
    };
  }
  if (type === "patch") {
    return { id, kind: "diff", data: { hash: stringValue(part, "hash"), files: part.files } };
  }
  return null;
}

/**
 * opencode keeps everything in one SQLite database: a session row, its messages,
 * and the parts each message is built from. Content lives in JSON `data`
 * columns rather than in typed columns, so the schema stays stable while the
 * shape of a part evolves.
 */
export class OpencodeV1Parser implements VersionedParser {
  readonly source = "opencode";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    if (!isSqliteBytes(request.raw)) {
      return { kind: "unknown", diagnostic: "opencode v1 requires a native SQLite database", raw: request.raw };
    }
    try {
      const sessions = withSqlite(request.raw, (database) => {
        const sessionRows = database
          .prepare("SELECT id, title, directory FROM session ORDER BY id")
          .all() as unknown as { id: string; title: string | null; directory: string | null }[];
        if (sessionRows.length === 0) throw new Error("database has no sessions");

        const messagesFor = database
          .prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id");
        const partsFor = database
          .prepare("SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id");

        return sessionRows.map((sessionRow, sessionIndex): Session => {
          const partsByMessage = new Map<string, PartRow[]>();
          for (const part of partsFor.all(sessionRow.id) as unknown as PartRow[]) {
            const bucket = partsByMessage.get(part.message_id);
            if (bucket) bucket.push(part);
            else partsByMessage.set(part.message_id, [part]);
          }

          const messages = messagesFor.all(sessionRow.id) as unknown as MessageRow[];
          const turns = messages.map((message, ordinal): Turn => {
            const data = JSON.parse(message.data) as Record<string, unknown>;
            const blocks = (partsByMessage.get(message.id) ?? [])
              .map((part) => partToBlock(JSON.parse(part.data) as Record<string, unknown>, part.id))
              .filter((block): block is ContentBlock => block !== null);
            const tokens = isRecord(data.tokens) ? data.tokens : null;
            const model = stringValue(data, "modelID");
            const turn: Turn = {
              id: message.id,
              ordinal,
              parentId: stringValue(data, "parentID"),
              role: turnRole(stringValue(data, "role")),
              createdAt: new Date(message.time_created).toISOString(),
              blocks,
            };
            if (model) turn.model = model;
            if (tokens) {
              turn.tokens = {
                input: typeof tokens.input === "number" ? tokens.input : 0,
                output: typeof tokens.output === "number" ? tokens.output : 0,
              };
            }
            return turn;
          });

          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId: sessionRow.id },
            ...(sessionRow.title ? { title: sessionRow.title } : {}),
            ...(sessionRow.directory ? { workspace: { ...request.seed.workspace, path: sessionRow.directory } } : {}),
            turns,
          };
        });
      });
      return { kind: "parsed", parser: "opencode:v1:0.2.0", sessions };
    } catch (error) {
      return {
        kind: "unknown",
        diagnostic: `opencode v1 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`,
        raw: request.raw,
      };
    }
  }
}
