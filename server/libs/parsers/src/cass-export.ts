import type { Session, Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, stringValue } from "./common.js";
import { turnFromRow } from "./sqlite-rows.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

export class CassExportParser implements VersionedParser {
  readonly source = "cass-export";
  readonly versions = ["2026-08"] as const;

  parse(request: ParseRequest): ParseResult {
    try {
      const input = JSON.parse(Buffer.from(request.raw).toString("utf8")) as unknown;
      if (!isRecord(input) || typeof input.cassVersion !== "number" || !Array.isArray(input.sessions)) {
        return { kind: "unknown", diagnostic: "cass-export requires cassVersion and a sessions array", raw: request.raw };
      }
      const sessions = input.sessions.map((entry, sessionIndex): Session => {
        if (!isRecord(entry) || !Array.isArray(entry.messages)) throw new Error(`cass session ${sessionIndex} has no messages array`);
        const record = entry as Record<string, unknown>;
        const turns = entry.messages.map((message, ordinal): Turn => {
          if (!isRecord(message)) throw new Error(`cass session ${sessionIndex} message ${ordinal} is not an object`);
          return turnFromRow({
            id: typeof message.id === "string" ? message.id : undefined,
            parentId: typeof message.parentId === "string" ? message.parentId : null,
            role: typeof message.role === "string" ? message.role : undefined,
            createdAt: typeof message.at === "string" ? message.at : undefined,
            blocks: message.parts,
          }, ordinal, request.seed);
        });
        const nativeSessionId = stringValue(record, "id") ?? `${request.seed.source.nativeSessionId ?? "cass"}:${sessionIndex}`;
        const title = stringValue(record, "title");
        return {
          ...request.seed,
          id: sessionIndex === 0 ? request.seed.id : incrementUuid(request.seed.id, sessionIndex),
          source: { ...request.seed.source, nativeSessionId },
          ...(title ? { title } : {}),
          turns,
        };
      });
      return { kind: "parsed", parser: "cass-export:2026-08:0.2.0", sessions };
    } catch (error) {
      return { kind: "unknown", diagnostic: `cass-export decode failed: ${error instanceof Error ? error.message : String(error)}`, raw: request.raw };
    }
  }
}
