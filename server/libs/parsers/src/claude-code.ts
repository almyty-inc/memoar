import type { Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, parseBlock, parseJsonLines, stringValue, withModelAndTokens } from "./common.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

export class ClaudeCodeV1Parser implements VersionedParser {
  readonly source = "claude-code";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    const all = parseJsonLines(request.raw);
    if (!all?.length) {
      return { kind: "unknown", diagnostic: "claude-code v1 requires JSON lines", raw: request.raw };
    }
    // A real transcript interleaves conversation with bookkeeping Claude Code
    // keeps for itself: attachments, file-history snapshots and deltas, mode
    // and permission changes, generated titles, queued operations. Requiring
    // uuid and message on every line refused the whole file over lines that
    // were never meant to be messages.
    const records = all.filter((record) => stringValue(record, "uuid") !== null && isRecord(record.message));
    if (records.length === 0) {
      return { kind: "unknown", diagnostic: "claude-code v1 found no message records among the JSONL lines", raw: request.raw };
    }
    // Blocks are numbered once for the whole session. Deriving them from
    // neighbouring record uuids produced 802 duplicate ids in a 4,369-turn
    // transcript, because adjacent uuids are close enough that the ranges met.
    let blockOrdinal = 0;
    const mintBlock = () => incrementUuid(request.seed.id, 0x8000000 + (blockOrdinal += 1));

    const turns: Turn[] = records.map((record, ordinal) => {
      const message = record.message as Record<string, unknown>;
      const id = stringValue(record, "uuid")!;
      const roleValue = stringValue(message, "role") ?? stringValue(record, "type") ?? "user";
      const role = roleValue === "assistant" || roleValue === "tool" || roleValue === "system" ? roleValue : "user";
      const content = message.content;
      const rawBlocks = Array.isArray(content) ? content : [content];
      const blocks = rawBlocks.map((block) => parseBlock(block, mintBlock())).filter((block) => block !== null);
      return withModelAndTokens({
        id,
        ordinal,
        parentId: stringValue(record, "parentUuid"),
        role,
        createdAt: stringValue(record, "timestamp") ?? request.seed.createdAt,
        blocks,
      }, typeof message.model === "string" ? message.model : request.seed.models[0], request.seed.tokenTotals.input, request.seed.tokenTotals.output);
    });
    return { kind: "parsed", parser: "claude-code:v1:0.2.0", sessions: [{ ...request.seed, turns }] };
  }
}
