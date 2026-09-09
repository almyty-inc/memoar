import type { ContentBlock, Session, Turn } from "../../canonical/src/generated.js";
import { blockId, incrementUuid, isRecord, mapParent, stringValue, turnId } from "./common.js";
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
function partsToBlocks(part: Record<string, unknown>, id: string, resultId: string): ContentBlock[] {
  const type = stringValue(part, "type");
  if (type === "text") {
    const text = stringValue(part, "text");
    return text === null || text.length === 0 ? [] : [{ id, kind: "text", text }];
  }
  if (type === "reasoning") {
    const text = stringValue(part, "text");
    return text === null || text.length === 0 ? [] : [{ id, kind: "thinking", text }];
  }
  if (type === "tool") {
    const state = isRecord(part.state) ? part.state : {};
    const callId = stringValue(part, "callID") ?? id;
    const blocks: ContentBlock[] = [{
      id,
      kind: "tool_call",
      name: stringValue(part, "tool") ?? "tool",
      callId,
      data: isRecord(state.input) ? state.input : {},
    }];
    // opencode keeps the command and what it printed in one part, and only the
    // command was being kept: every `ls`, every test run, every diff an agent
    // read came back empty in the archive. A session where you can see what was
    // asked and not what came back is not a record of what happened.
    const output = stringValue(state, "output");
    if (output !== null && output.length > 0) {
      blocks.push({ id: resultId, kind: "tool_result", callId, text: output });
    }
    return blocks;
  }
  if (type === "patch") {
    return [{ id, kind: "diff", data: { hash: stringValue(part, "hash"), files: part.files } }];
  }
  return [];
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
              // Block ids are a uuid column too, and a part id is opencode's
              // own, so it is derived rather than trusted. A tool part becomes
              // two blocks — the call and what it returned — so the result gets
              // its own derived id rather than colliding with the call's.
              .flatMap((part) => partsToBlocks(
                JSON.parse(part.data) as Record<string, unknown>,
                blockId(part.id, request.seed.id),
                blockId(`${part.id}:result`, request.seed.id),
              ));
            const tokens = isRecord(data.tokens) ? data.tokens : null;
            const model = stringValue(data, "modelID");
            const turn: Turn = {
              // opencode numbers its messages its own way, and a turn id is a
              // uuid column: passed through, one such id refuses the session.
              id: turnId(message.id, request.seed.id),
              ordinal,
              parentId: mapParent(stringValue(data, "parentID"), request.seed.id),
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
