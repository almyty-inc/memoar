import type { ContentBlock, Session, TokenTotals, Turn } from "../../canonical/src/generated.js";
import { blockId, incrementUuid, isRecord, mapParent, sessionModels, stringValue, turnId } from "./common.js";
import { storedSessions } from "./opencode-store.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import { tokenTotals } from "./tokens.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";
import { parserVersion } from "./versions.js";

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
    // Provider metadata is where an encrypted reasoning payload is kept.
    const text = stringValue(part, "text");
    const metadata = isRecord(part.metadata) && Object.keys(part.metadata).length > 0 ? { data: { metadata: part.metadata } } : {};
    return (text === null || text.length === 0) && !("data" in metadata) ? [] : [{ id, kind: "thinking", ...(text ? { text } : {}), ...metadata }];
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
    //
    // A failed call keeps its error under `state.error` instead, and the
    // tool's own account of what it did (the diff an edit made, a title) under
    // `state.metadata` and `state.title`. Those were dropped too.
    const output = stringValue(state, "output");
    const error = stringValue(state, "error");
    const data: Record<string, unknown> = {};
    if (error !== null) data.isError = true;
    for (const key of ["title", "metadata", "attachments"] as const) {
      if (state[key] !== undefined && state[key] !== null) data[key] = state[key];
    }
    const text = output !== null && output.length > 0 ? output : error;
    if (text !== null || Object.keys(data).length > 0) {
      blocks.push({ id: resultId, kind: "tool_result", callId, ...(text !== null ? { text } : {}), ...(Object.keys(data).length > 0 ? { data } : {}) });
    }
    return blocks;
  }
  if (type === "patch") {
    return [{ id, kind: "diff", data: { hash: stringValue(part, "hash"), files: part.files } }];
  }
  if (type === "file") return [fileBlock(part, id)];
  if (type === "step-start" || type === "step-finish" || type === "snapshot") return [];
  // Subtasks, agent switches, compaction markers, retries, and any part type
  // added since this was written: their prose if they have any, and the part.
  const text = stringValue(part, "prompt") ?? stringValue(part, "text") ?? stringValue(part, "description");
  return [{ id, kind: type === "retry" ? "error" : "system", name: type ?? "part", ...(text ? { text } : {}), data: part }];
}

/**
 * `{input, output, reasoning, cache: {read, write}, total}` on an assistant
 * message. opencode already takes the cache out of `input`, and keeps the
 * reasoning out of `output`, so reasoning is added back to match how every
 * other source counts it. The cache was not read before.
 */
function opencodeTokens(tokens: Record<string, unknown>): TokenTotals {
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  const reasoning = typeof tokens.reasoning === "number" && tokens.reasoning > 0 ? tokens.reasoning : 0;
  const output = typeof tokens.output === "number" && tokens.output > 0 ? tokens.output : 0;
  return tokenTotals(tokens.input, output + reasoning, cache.read, cache.write);
}

/**
 * A file the person attached or @-mentioned: `{mime, filename, url, source}`.
 * The url is a `data:` URL when the bytes were inlined, and `source.text`
 * holds the text opencode sent to the model for a mentioned file.
 */
function fileBlock(part: Record<string, unknown>, id: string): ContentBlock {
  const url = stringValue(part, "url");
  const mime = stringValue(part, "mime");
  const filename = stringValue(part, "filename");
  const source = isRecord(part.source) ? part.source : null;
  const sourceText = source && isRecord(source.text) ? stringValue(source.text, "value") : null;
  return {
    id,
    kind: "attachment",
    ...(filename ? { name: filename } : {}),
    ...(mime ? { mimeType: mime } : {}),
    ...(url && !url.startsWith("data:") ? { artifactRef: url } : {}),
    ...(sourceText ? { text: sourceText } : {}),
    ...(url?.startsWith("data:") || source ? { data: { ...(url?.startsWith("data:") ? { url } : {}), ...(source ? { source } : {}) } } : {}),
  };
}

/**
 * opencode keeps everything in one SQLite database: a session row, its messages,
 * and the parts each message is built from. Content lives in JSON `data`
 * columns rather than in typed columns, so the schema stays stable while the
 * shape of a part evolves.
 */
export class OpencodeV1Parser implements VersionedParser {
  readonly versions = ["v1"] as const;

  /** Kilo Code was rebuilt on opencode and writes the same schema. */
  constructor(readonly source: "opencode" | "kilo" = "opencode") {}

  parse(request: ParseRequest): ParseResult {
    if (!isSqliteBytes(request.raw)) {
      return { kind: "unknown", diagnostic: `${this.source} v1 requires a native SQLite database`, raw: request.raw };
    }
    try {
      const sessions = withSqlite(request.raw, (database) => {
        const stored = storedSessions(database);
        if (stored.length === 0) throw new Error("database has no sessions");

        return stored.map((sessionRow, sessionIndex): Session => {
          const turns = sessionRow.messages.map((message, ordinal): Turn => {
            const data = message.data;
            const blocks = message.parts
              // Block ids are a uuid column too, and a part id is opencode's
              // own, so it is derived rather than trusted. A tool part becomes
              // two blocks — the call and what it returned — so the result gets
              // its own derived id rather than colliding with the call's.
              .flatMap((part) => partsToBlocks(
                part.data,
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
              createdAt: new Date(message.timeCreated).toISOString(),
              blocks,
            };
            if (model) turn.model = model;
            if (tokens) turn.tokens = opencodeTokens(tokens);
            return turn;
          });

          const models = sessionModels(request.seed.models, turns, sessionRow.model);
          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId: sessionRow.id },
            ...(sessionRow.title ? { title: sessionRow.title } : {}),
            ...(sessionRow.directory ? { workspace: { ...request.seed.workspace, path: sessionRow.directory } } : {}),
            models,
            turns,
          };
        });
      });
      return { kind: "parsed", parser: parserVersion(this.source), sessions };
    } catch (error) {
      return {
        kind: "unknown",
        diagnostic: `${this.source} v1 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`,
        raw: request.raw,
      };
    }
  }
}
