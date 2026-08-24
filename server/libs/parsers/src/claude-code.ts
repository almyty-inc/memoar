import type { Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, parseBlock, parseJsonLines, stringValue, withModelAndTokens } from "./common.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

export class ClaudeCodeV1Parser implements VersionedParser {
  readonly source = "claude-code";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    const records = parseJsonLines(request.raw);
    if (!records?.length || records.some((record) => !stringValue(record, "uuid") || !isRecord(record.message))) {
      return { kind: "unknown", diagnostic: "claude-code v1 requires uuid and message on each JSONL record", raw: request.raw };
    }
    const turns: Turn[] = records.map((record, ordinal) => {
      const message = record.message as Record<string, unknown>;
      const id = stringValue(record, "uuid")!;
      const roleValue = stringValue(message, "role") ?? stringValue(record, "type") ?? "user";
      const role = roleValue === "assistant" || roleValue === "tool" || roleValue === "system" ? roleValue : "user";
      const content = message.content;
      const fallbackStart = role === "user" && records[ordinal + 1]
        ? incrementUuid(stringValue(records[ordinal + 1]!, "uuid")!, 1)
        : incrementUuid(id, 1);
      const rawBlocks = Array.isArray(content) ? content : [content];
      const blocks = rawBlocks.map((block, index) => parseBlock(block, incrementUuid(fallbackStart, index))).filter((block) => block !== null);
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
