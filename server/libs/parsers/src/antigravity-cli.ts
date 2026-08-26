import type { Turn } from "../../canonical/src/generated.js";
import { incrementUuid, parseBlock, parseJsonLines, stringValue, withModelAndTokens } from "./common.js";
import { ensureRecord, parseJsonColumn, turnFromRow } from "./sqlite-rows.js";
import { isSqliteBytes, withSqlite } from "./sqlite.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

export class AntigravityCliV1Parser implements VersionedParser {
  readonly source = "antigravity-cli";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    if (isSqliteBytes(request.raw)) return this.parseDatabase(request);
    return this.parseJsonl(request);
  }

  private parseDatabase(request: ParseRequest): ParseResult {
    return parseTrajectoryDatabase(request, this.source);
  }

  private parseJsonl(request: ParseRequest): ParseResult {
    const records = parseJsonLines(request.raw);
    if (!records?.length || records.some((record) => record.type !== "message" || !stringValue(record, "id") || !Array.isArray(record.parts))) {
      return { kind: "unknown", diagnostic: "antigravity-cli v1 requires a native SQLite trajectory database or message records with id and parts", raw: request.raw };
    }
    const turns: Turn[] = records.map((record, ordinal) => {
      const id = stringValue(record, "id")!;
      const roleValue = stringValue(record, "role") ?? "user";
      const role = roleValue === "assistant" || roleValue === "tool" || roleValue === "system" ? roleValue : "user";
      const blocks = (record.parts as unknown[]).map((block, index) => parseBlock(block, incrementUuid(id, index + 1))).filter((block) => block !== null);
      return withModelAndTokens({
        id,
        ordinal,
        parentId: stringValue(record, "parentId"),
        role,
        createdAt: stringValue(record, "createdAt") ?? request.seed.createdAt,
        blocks,
      }, request.seed.models[0], request.seed.tokenTotals.input, request.seed.tokenTotals.output);
    });
    return { kind: "parsed", parser: "antigravity-cli:v1:0.1.0", sessions: [{ ...request.seed, turns }] };
  }
}

/**
 * Reads Antigravity's trajectory database. The CLI and the IDE write the same
 * trajectory_meta/steps tables, so they share this rather than keeping two
 * copies of the same SQL to drift apart.
 */
export function parseTrajectoryDatabase(request: ParseRequest, source: string): ParseResult {
  try {
    const turns = withSqlite(request.raw, (database) => {
      const meta = database
        .prepare("SELECT trajectory_id FROM trajectory_meta LIMIT 1")
        .get() as { trajectory_id?: string } | undefined;
      if (!meta?.trajectory_id) throw new Error("antigravity database lacks trajectory_meta");
      const rows = database
        .prepare("SELECT idx, step_payload FROM steps ORDER BY idx")
        .all() as { idx: number; step_payload: string | Uint8Array | null }[];
      if (!rows.length) throw new Error("antigravity database has no steps");
      return rows.map((row, ordinal): Turn => {
        const payload = ensureRecord(parseJsonColumn(row.step_payload, `steps.step_payload idx ${row.idx}`), `step payload idx ${row.idx}`);
        return turnFromRow({
          id: typeof payload.id === "string" ? payload.id : undefined,
          parentId: typeof payload.parentId === "string" ? payload.parentId : null,
          role: typeof payload.role === "string" ? payload.role : undefined,
          createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
          blocks: payload.parts,
        }, ordinal, request.seed);
      });
    });
    return { kind: "parsed", parser: `${source}:v1:0.2.0`, sessions: [{ ...request.seed, turns }] };
  } catch (error) {
    return { kind: "unknown", diagnostic: `${source} v1 sqlite decode failed: ${error instanceof Error ? error.message : String(error)}`, raw: request.raw };
  }
}

/** The IDE writes the same trajectory tables as the CLI. */
export class AntigravityIdeV1Parser implements VersionedParser {
  readonly source = "antigravity-ide";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    if (!isSqliteBytes(request.raw)) {
      return { kind: "unknown", diagnostic: "antigravity-ide v1 requires a native SQLite trajectory database", raw: request.raw };
    }
    return parseTrajectoryDatabase(request, this.source);
  }
}
