import { zstdDecompressSync } from "node:zlib";
import type { Session, Turn } from "../../canonical/src/generated.js";
import { incrementUuid } from "./common.js";
import { ensureRecord, turnFromRow } from "./sqlite-rows.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

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
          .all() as { id: string; summary: string | null; data_type: string; data: Uint8Array }[];
        if (!rows.length) throw new Error("zed v1 database has no thread rows");
        return rows.map((row, sessionIndex): Session => {
          if (row.data_type !== "zstd") throw new Error(`zed v1 thread ${row.id} data_type must be zstd, saw ${row.data_type}`);
          const decompressed = zstdDecompressSync(Buffer.from(row.data));
          const thread = ensureRecord(JSON.parse(decompressed.toString("utf8")), `thread ${row.id} blob`);
          if (!Array.isArray(thread.messages)) throw new Error(`zed v1 thread ${row.id} blob has no messages array`);
          const turns = thread.messages.map((message, ordinal): Turn => {
            const record = ensureRecord(message, `thread ${row.id} message ${ordinal}`);
            return turnFromRow({
              id: typeof record.id === "string" ? record.id : undefined,
              parentId: typeof record.parentId === "string" ? record.parentId : null,
              role: typeof record.role === "string" ? record.role : undefined,
              createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
              blocks: record.segments,
            }, ordinal, request.seed);
          });
          return {
            ...request.seed,
            id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
            source: { ...request.seed.source, nativeSessionId: row.id },
            ...(row.summary ? { title: row.summary } : {}),
            turns,
          };
        });
      });
      return { kind: "parsed", parser: "zed:v1:0.2.0", sessions };
    } catch (error) {
      return { kind: "unknown", diagnostic: `zed v1 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`, raw: request.raw };
    }
  }
}
