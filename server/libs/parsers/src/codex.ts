import type { Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, parseBlock, parseJsonLines, stringValue, withModelAndTokens } from "./common.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

export class CodexRolloutV1Parser implements VersionedParser {
  readonly source = "codex";
  readonly versions = ["rollout-v1"] as const;

  parse(request: ParseRequest): ParseResult {
    const records = parseJsonLines(request.raw);
    const meta = records?.find((record) => record.type === "session_meta");
    const events = records?.filter((record) => record.type === "response_item") ?? [];
    if (!meta || !isRecord(meta.payload) || !events.length || events.some((record) => !isRecord(record.payload))) {
      return { kind: "unknown", diagnostic: "codex rollout-v1 requires session_meta followed by response_item events", raw: request.raw };
    }
    const sessionId = stringValue(meta.payload, "id") ?? request.seed.id;
    const turns: Turn[] = events.map((record, ordinal) => {
      const payload = record.payload as Record<string, unknown>;
      const roleValue = stringValue(payload, "role") ?? "user";
      const role = roleValue === "assistant" || roleValue === "tool" || roleValue === "system" ? roleValue : "user";
      const id = incrementUuid(sessionId, ordinal + 1);
      const content = Array.isArray(payload.content) ? payload.content : [payload.content];
      const blocks = content.map((block, index) => parseBlock(block, incrementUuid(id, index + 2))).filter((block) => block !== null);
      return withModelAndTokens({
        id,
        ordinal,
        parentId: ordinal === 0 ? null : incrementUuid(sessionId, ordinal),
        role,
        createdAt: stringValue(record, "timestamp") ?? request.seed.createdAt,
        blocks,
      }, request.seed.models[0], request.seed.tokenTotals.input, request.seed.tokenTotals.output);
    });
    return { kind: "parsed", parser: "codex:rollout-v1:0.2.0", sessions: [{ ...request.seed, id: sessionId, turns }] };
  }
}
