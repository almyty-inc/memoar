import { zstdDecompressSync } from "node:zlib";
import type { ContentBlock, Session, Turn } from "../../canonical/src/generated.js";
import { derivedBlockId, incrementUuid, isRecord, stringValue } from "./common.js";
import { ensureRecord } from "./sqlite-rows.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

/**
 * Zed serializes its thread from Rust, so enums arrive externally tagged: a
 * message is `{ "User": { .. } }` rather than an object with a role field, and
 * a piece of content is `{ "Text": ".." }` rather than one with a kind field.
 * Reading the single key is how the variant is recovered.
 */
function variant(value: unknown): { tag: string; body: unknown } | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const tag = keys[0]!;
  return { tag, body: value[tag] };
}

function turnRole(tag: string): Turn["role"] {
  const normalized = tag.toLowerCase();
  if (normalized === "agent" || normalized === "assistant") return "assistant";
  if (normalized === "tool" || normalized === "toolresult") return "tool";
  if (normalized === "system" || normalized === "resume") return "system";
  return "user";
}

/** Maps one tagged content item onto a canonical block. */
function contentBlock(item: unknown, id: string): ContentBlock | null {
  const tagged = variant(item);
  if (!tagged) return null;
  const { tag, body } = tagged;
  const normalized = tag.toLowerCase();

  if (normalized === "text") {
    const text = typeof body === "string" ? body : isRecord(body) ? stringValue(body, "text") : null;
    return text === null || text.length === 0 ? null : { id, kind: "text", text };
  }
  if (normalized === "thinking" || normalized === "redactedthinking") {
    const text = typeof body === "string" ? body : isRecord(body) ? stringValue(body, "text") : null;
    return text === null || text.length === 0 ? null : { id, kind: "thinking", text };
  }
  if (normalized === "tooluse" || normalized === "tool_use") {
    const record = isRecord(body) ? body : {};
    return {
      id,
      kind: "tool_call",
      name: stringValue(record, "name") ?? "tool",
      callId: stringValue(record, "id") ?? id,
      data: isRecord(record.input) ? record.input : {},
    };
  }
  return null;
}

/**
 * Zed keeps one row per thread, with the thread itself zstd-compressed in a
 * blob. `data_type` names the compression, so an uncompressed row is read as-is
 * rather than refused.
 */
export class ZedV1Parser implements VersionedParser {
  readonly source = "zed";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    if (!isSqliteBytes(request.raw)) {
      return { kind: "unknown", diagnostic: "zed v1 requires a native SQLite threads database", raw: request.raw };
    }
    try {
      const sessions = withSqlite(request.raw, (database) => {
        const rows = database
          .prepare("SELECT id, summary, data_type, data FROM threads ORDER BY id")
          .all() as unknown as { id: string; summary: string | null; data_type: string; data: Uint8Array | string }[];
        if (!rows.length) throw new Error("database has no thread rows");

        return rows.map((row, sessionIndex): Session => {
          const bytes = typeof row.data === "string" ? Buffer.from(row.data, "utf8") : Buffer.from(row.data);
          const text = row.data_type === "zstd" ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
          const thread = ensureRecord(JSON.parse(text), `thread ${row.id} blob`);
          if (!Array.isArray(thread.messages)) throw new Error(`thread ${row.id} has no messages array`);

          let previousId: string | null = null;
          const turns = thread.messages.flatMap((message, ordinal): Turn[] => {
            const tagged = variant(message);
            if (!tagged || !isRecord(tagged.body)) return [];
            const body = tagged.body;
            const id = stringValue(body, "id") ?? incrementUuid(request.seed.id, ordinal + 1);
            const content = Array.isArray(body.content) ? body.content : [];
            const blocks = content
              .map((item, index) => contentBlock(item, derivedBlockId(id, index + 1, request.seed.id, ordinal)))
              .filter((block): block is ContentBlock => block !== null);
            if (blocks.length === 0) return [];
            const turn: Turn = {
              id,
              ordinal: 0,
              // Zed stores a flat list, so the thread order is the parent chain.
              parentId: previousId,
              role: turnRole(tagged.tag),
              createdAt: stringValue(thread, "updated_at") ?? request.seed.createdAt,
              blocks,
            };
            previousId = id;
            return [turn];
          }).map((turn, ordinal) => ({ ...turn, ordinal }));

          const title = stringValue(thread, "title") || row.summary;
          const model = stringValue(thread, "model");
          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId: row.id },
            ...(title ? { title } : {}),
            ...(model ? { models: [model] } : {}),
            turns,
          };
        });
      });
      return { kind: "parsed", parser: "zed:v1:0.2.0", sessions };
    } catch (error) {
      return {
        kind: "unknown",
        diagnostic: `zed v1 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`,
        raw: request.raw,
      };
    }
  }
}
