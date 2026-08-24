import type { Session, Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, parseBlock, stringValue, withModelAndTokens } from "./common.js";
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

  private parseDatabase(request: ParseRequest): ParseResult {
    try {
      const sessions = withSqlite(request.raw, (database) => {
        const rows = database
          .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY key")
          .all() as { key: string; value: string | Uint8Array }[];
        if (!rows.length) throw new Error("cursor v3 database has no composerData rows");
        return rows.map((row, sessionIndex): Session => {
          const payload = ensureRecord(parseJsonColumn(row.value, row.key), row.key);
          if (!Array.isArray(payload.conversation)) throw new Error(`${row.key} has no conversation array`);
          const turns = payload.conversation.map((entry, ordinal): Turn => {
            if (!isRecord(entry)) throw new Error(`${row.key} conversation entry ${ordinal} is not an object`);
            const id = stringValue(entry, "bubbleId");
            if (!id) throw new Error(`${row.key} conversation entry ${ordinal} lacks bubbleId`);
            const roleValue = stringValue(entry, "role") ?? "user";
            const role = roleValue === "assistant" || roleValue === "tool" || roleValue === "system" ? roleValue : "user";
            const rawBlocks = Array.isArray(entry.blocks) ? entry.blocks : [];
            const blocks = rawBlocks.map((block, index) => parseBlock(block, incrementUuid(id, index + 1))).filter((block) => block !== null);
            return withModelAndTokens({
              id,
              ordinal,
              parentId: stringValue(entry, "parentBubbleId"),
              role,
              createdAt: stringValue(entry, "createdAt") ?? request.seed.createdAt,
              blocks,
            }, request.seed.models[0], request.seed.tokenTotals.input, request.seed.tokenTotals.output);
          });
          const nativeSessionId = typeof payload.composerId === "string"
            ? payload.composerId
            : row.key.slice("composerData:".length);
          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId },
            ...(typeof payload.name === "string" ? { title: payload.name } : {}),
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
