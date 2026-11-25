import { zstdDecompressSync } from "node:zlib";
import type { ContentBlock, Session, Turn } from "../../canonical/src/generated.js";
import { derivedBlockId, incrementUuid, isRecord, stringValue, turnId } from "./common.js";
import { ensureRecord } from "./sqlite-rows.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";
import { parserVersion } from "./versions.js";

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
  if (normalized === "thinking") {
    const text = typeof body === "string" ? body : isRecord(body) ? stringValue(body, "text") : null;
    const signature = isRecord(body) ? stringValue(body, "signature") : null;
    if (!text && !signature) return null;
    return { id, kind: "thinking", ...(text ? { text } : {}), ...(signature ? { data: { signature } } : {}) };
  }
  // The payload of redacted reasoning is opaque. It was stored as the thinking
  // text, so a reader saw ciphertext as if the model had written it.
  if (normalized === "redactedthinking") {
    return typeof body === "string" && body.length > 0 ? { id, kind: "thinking", data: { redacted: true, data: body } } : null;
  }
  // A file or symbol the person @-mentioned, with the content Zed sent along.
  if (normalized === "mention") {
    const record = isRecord(body) ? body : {};
    const uri = stringValue(record, "uri") ?? (isRecord(record.uri) ? JSON.stringify(record.uri) : null);
    const text = stringValue(record, "content");
    return { id, kind: "attachment", ...(text ? { text } : {}), ...(uri ? { artifactRef: uri } : {}), ...(isRecord(record.uri) ? { data: { uri: record.uri } } : {}) };
  }
  if (normalized === "image") return zedImage(body, id);
  if (normalized === "tooluse" || normalized === "tool_use") {
    const record = isRecord(body) ? body : {};
    return {
      id,
      kind: "tool_call",
      name: stringValue(record, "name") ?? "tool",
      callId: stringValue(record, "id") ?? id,
      data: isRecord(record.input) ? record.input : typeof record.raw_input === "string" ? { raw_input: record.raw_input } : {},
    };
  }
  // A variant added since this was written is kept whole.
  return { id, kind: "text", ...(typeof body === "string" ? { text: body } : {}), ext: { nativeKind: tag, native: item } };
}

/** `LanguageModelImage`: base64 PNG bytes in `source`, and their size. */
function zedImage(body: unknown, id: string): ContentBlock {
  const record = isRecord(body) ? body : {};
  return { id, kind: "attachment", mimeType: "image/png", data: { source: record.source ?? null, ...(record.size ? { size: record.size } : {}) } };
}

/**
 * What a tool returned. An agent message keeps its tool results in a map
 * beside its content, `tool_results: {<id>: {tool_use_id, tool_name, is_error,
 * content: {Text}|{Image}, output}}`, and nothing read it: every result in
 * every Zed thread was dropped.
 */
function toolResultBlocks(results: unknown, mint: () => string): ContentBlock[] {
  if (!isRecord(results)) return [];
  return Object.entries(results).flatMap(([key, value]): ContentBlock[] => {
    if (!isRecord(value)) return [];
    const content = variant(value.content);
    const text = content && content.tag.toLowerCase() === "text" && typeof content.body === "string" ? content.body
      : typeof value.content === "string" ? value.content : null;
    const data: Record<string, unknown> = {};
    if (value.is_error === true) data.isError = true;
    if (content && content.tag.toLowerCase() !== "text") data.content = value.content;
    if (value.output !== undefined && value.output !== null) data.output = value.output;
    const name = stringValue(value, "tool_name");
    return [{
      id: mint(),
      kind: "tool_result",
      callId: stringValue(value, "tool_use_id") ?? key,
      ...(name ? { name } : {}),
      ...(text !== null ? { text } : {}),
      ...(Object.keys(data).length > 0 ? { data } : {}),
    }];
  });
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
            // Zed's message ids are uuids and are kept. One that is not would
            // refuse the whole thread at the uuid column, so it is derived.
            const nativeId = stringValue(body, "id");
            const id = nativeId ? turnId(nativeId, request.seed.id) : incrementUuid(request.seed.id, ordinal + 1);
            const content = Array.isArray(body.content) ? body.content : [];
            const blocks = content
              .map((item, index) => contentBlock(item, derivedBlockId(id, index + 1, request.seed.id, ordinal)))
              .filter((block): block is ContentBlock => block !== null);
            let next = content.length;
            blocks.push(...toolResultBlocks(body.tool_results, () => derivedBlockId(id, (next += 1), request.seed.id, ordinal)));
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
          const detailed = stringValue(thread, "detailed_summary");
          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId: row.id },
            ...(title ? { title } : {}),
            ...(model ? { models: [model] } : {}),
            // Zed's own summary of the thread, written by the model.
            ...(detailed ? { ext: { ...request.seed.ext, zed: { detailedSummary: detailed } } } : {}),
            turns,
          };
        });
      });
      return { kind: "parsed", parser: parserVersion(this.source), sessions };
    } catch (error) {
      return {
        kind: "unknown",
        diagnostic: `zed v1 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`,
        raw: request.raw,
      };
    }
  }
}
