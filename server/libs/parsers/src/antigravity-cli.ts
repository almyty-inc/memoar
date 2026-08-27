import type { Turn } from "../../canonical/src/generated.js";
import { isRecord, incrementUuid, parseBlock, parseJsonLines, stringValue, withModelAndTokens } from "./common.js";
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

  /**
   * Reads the transcript log the CLI writes beside a session.
   *
   * It is a log of steps, not of messages: each line records something that
   * happened — the user's request, the planner's response with its reasoning
   * and tool calls, the output of a command or a file read, and the
   * checkpoints and history markers the CLI keeps for itself. Steps are not
   * written in order, so they are sorted by step_index before being read.
   */
  private parseJsonl(request: ParseRequest): ParseResult {
    const records = parseJsonLines(request.raw);
    if (!records?.length) {
      return { kind: "unknown", diagnostic: "antigravity-cli v1 requires a native SQLite trajectory database or a transcript log", raw: request.raw };
    }

    const steps = [...records]
      .filter((record) => stringValue(record, "type") !== null)
      .sort((left, right) => Number(left.step_index ?? 0) - Number(right.step_index ?? 0));

    const turns: Turn[] = [];
    let blockOrdinal = 0;
    const mint = () => incrementUuid(request.seed.id, 0x10000000 + (blockOrdinal += 1));

    const openAssistant = (createdAt: string): Turn => {
      const last = turns.at(-1);
      if (last && last.role === "assistant") return last;
      const turn = withModelAndTokens({
        id: incrementUuid(request.seed.id, turns.length + 1),
        ordinal: turns.length,
        parentId: turns.at(-1)?.id ?? null,
        role: "assistant" as const,
        createdAt,
        blocks: [],
      }, request.seed.models[0], request.seed.tokenTotals.input, request.seed.tokenTotals.output);
      turns.push(turn);
      return turn;
    };

    for (const step of steps) {
      const type = stringValue(step, "type");
      const createdAt = stringValue(step, "created_at") ?? request.seed.createdAt;
      const content = stringValue(step, "content");

      if (type === "USER_INPUT") {
        if (content === null || content.length === 0) continue;
        turns.push({
          id: incrementUuid(request.seed.id, turns.length + 1),
          ordinal: turns.length,
          parentId: turns.at(-1)?.id ?? null,
          role: "user",
          createdAt,
          blocks: [{ id: mint(), kind: "text", text: content }],
        });
        continue;
      }

      if (type === "PLANNER_RESPONSE") {
        const turn = openAssistant(createdAt);
        const thinking = stringValue(step, "thinking");
        if (thinking) turn.blocks.push({ id: mint(), kind: "thinking", text: thinking });
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        for (const call of calls) {
          if (!isRecord(call)) continue;
          turn.blocks.push({
            id: mint(),
            kind: "tool_call",
            name: stringValue(call, "name") ?? "tool",
            callId: stringValue(call, "id") ?? mint(),
            data: isRecord(call.args) ? call.args : {},
          });
        }
        if (content) turn.blocks.push({ id: mint(), kind: "text", text: content });
        continue;
      }

      // Step types that report what a tool did. Their output belongs to the
      // assistant turn that asked for it.
      if (type === "VIEW_FILE" || type === "RUN_COMMAND" || type === "EDIT_FILE" || type === "SEARCH") {
        if (content === null || content.length === 0) continue;
        openAssistant(createdAt).blocks.push({ id: mint(), kind: "tool_result", text: content });
        continue;
      }
      // CHECKPOINT and CONVERSATION_HISTORY are the CLI's own bookkeeping, and
      // anything unrecognised is a step type added since this was written.
    }

    const withOrdinals = turns
      .filter((turn) => turn.blocks.length > 0)
      .map((turn, ordinal) => ({ ...turn, ordinal }));
    if (withOrdinals.length === 0) {
      return { kind: "unknown", diagnostic: "antigravity-cli v1 transcript contained no readable steps", raw: request.raw };
    }
    return { kind: "parsed", parser: "antigravity-cli:v1:0.2.0", sessions: [{ ...request.seed, turns: withOrdinals }] };
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
