import type { ContentBlock, Session, Turn } from "../../canonical/src/generated.js";
import { epochToIso, incrementUuid, isRecord, stringValue, withModelAndTokens } from "./common.js";
import { ensureRecord, parseJsonColumn } from "./sqlite-rows.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

export class CursorV3Parser implements VersionedParser {
  readonly source = "cursor";
  readonly versions = ["v3"] as const;

  parse(request: ParseRequest): ParseResult {
    if (isSqliteBytes(request.raw)) return this.parseDatabase(request);
    return this.parseLegacyEnvelope(request);
  }

  /**
   * Cursor keeps a conversation in two places. `composerData:<id>` holds the
   * metadata and, in `fullConversationHeadersOnly`, the ordered index of the
   * turns; each turn itself is a separate `bubbleId:<composerId>:<bubbleId>`
   * row. Reading composerData alone — which is what this did — finds the index
   * but never the content, because the conversation was never stored there.
   */
  private parseDatabase(request: ParseRequest): ParseResult {
    try {
      const sessions = withSqlite(request.raw, (database) => {
        const composerRows = database
          .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY key")
          .all() as unknown as { key: string; value: string | Uint8Array }[];
        if (!composerRows.length) throw new Error("database has no composerData rows");

        const bubbleRows = database
          .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'")
          .all() as unknown as { key: string; value: string | Uint8Array }[];
        const bubbles = new Map<string, Record<string, unknown>>();
        for (const row of bubbleRows) {
          try {
            bubbles.set(row.key, ensureRecord(parseJsonColumn(row.value, row.key), row.key));
          } catch {
            // One unreadable bubble must not cost the whole conversation.
          }
        }

        return composerRows.map((row, sessionIndex): Session => {
          const payload = ensureRecord(parseJsonColumn(row.value, row.key), row.key);
          const composerId = stringValue(payload, "composerId") ?? row.key.slice("composerData:".length);
          const headers = Array.isArray(payload.fullConversationHeadersOnly)
            ? payload.fullConversationHeadersOnly
            : [];

          let blockOrdinal = 0;
          const mint = () => incrementUuid(request.seed.id, 0x20000000 + (blockOrdinal += 1));
          let previousId: string | null = null;

          const turns = headers.flatMap((header, ordinal): Turn[] => {
            if (!isRecord(header)) return [];
            const bubbleId = stringValue(header, "bubbleId");
            if (!bubbleId) return [];
            const bubble = bubbles.get(`bubbleId:${composerId}:${bubbleId}`);
            if (!bubble) return [];

            // type 1 is what the user sent, type 2 what the model replied.
            const typeValue = typeof bubble.type === "number" ? bubble.type : Number(stringValue(header, "type") ?? 1);
            const role = typeValue === 2 ? "assistant" : "user";
            const blocks: ContentBlock[] = [];

            for (const thought of Array.isArray(bubble.allThinkingBlocks) ? bubble.allThinkingBlocks : []) {
              const text = typeof thought === "string" ? thought : isRecord(thought) ? stringValue(thought, "text") : null;
              if (text) blocks.push({ id: mint(), kind: "thinking", text });
            }
            const text = stringValue(bubble, "text");
            if (text) blocks.push({ id: mint(), kind: "text", text });
            for (const result of Array.isArray(bubble.toolResults) ? bubble.toolResults : []) {
              if (!isRecord(result)) continue;
              const output = stringValue(result, "result") ?? stringValue(result, "output") ?? stringValue(result, "text");
              blocks.push({
                id: mint(),
                kind: "tool_result",
                ...(stringValue(result, "toolCallId") ? { callId: stringValue(result, "toolCallId")! } : {}),
                ...(output ? { text: output } : {}),
              });
            }
            if (blocks.length === 0) return [];

            const turn = withModelAndTokens({
              id: bubbleId,
              ordinal,
              // Cursor stores a flat ordered index, so order is the chain.
              parentId: previousId,
              role,
              createdAt: epochToIso(payload.createdAt, request.seed.createdAt),
              blocks,
            }, request.seed.models[0], request.seed.tokenTotals.input, request.seed.tokenTotals.output);
            previousId = bubbleId;
            return [turn];
          }).map((turn, ordinal) => ({ ...turn, ordinal }));

          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId: composerId },
            ...(typeof payload.name === "string" && payload.name ? { title: payload.name } : {}),
            turns,
          };
        });
      });
      return { kind: "parsed", parser: "cursor:v3:0.2.0", sessions };
    } catch (error) {
      return { kind: "unknown", diagnostic: `cursor v3 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`, raw: request.raw };
    }
  }

  private parseLegacyEnvelope(request: ParseRequest): ParseResult {
    try {
      const input = JSON.parse(Buffer.from(request.raw).toString("utf8")) as unknown;
      if (!isRecord(input) || input.source !== "cursor" || input.version !== "v3" || !isRecord(input.session) || !Array.isArray(input.session.turns)) {
        return { kind: "unknown", diagnostic: "cursor v3 requires a native SQLite database or a legacy database row envelope", raw: request.raw };
      }
      return { kind: "parsed", parser: "cursor:v3:0.1.0", sessions: [structuredClone(input.session) as unknown as Session] };
    } catch {
      return { kind: "unknown", diagnostic: "cursor v3 payload is neither SQLite nor valid JSON", raw: request.raw };
    }
  }
}
