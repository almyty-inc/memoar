import type { Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, mapParent, parseBlock, parseJsonLines, stringValue, turnId, withModelAndTokens } from "./common.js";
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
      // Claude Code writes real uuids, so this normally returns exactly what
      // the transcript said. It is here for the transcript that does not.
      const id = turnId(stringValue(record, "uuid")!, request.seed.id);
      const roleValue = stringValue(message, "role") ?? stringValue(record, "type") ?? "user";
      const role = roleValue === "assistant" || roleValue === "tool" || roleValue === "system" ? roleValue : "user";
      const content = message.content;
      const rawBlocks = Array.isArray(content) ? content : [content];
      const blocks = rawBlocks.map((block) => parseBlock(block, mintBlock())).filter((block) => block !== null);
      return withModelAndTokens({
        id,
        ordinal,
        // Through the same derivation as the id above, or a remapped turn would
        // be pointed at by a parent link that still names the original.
        parentId: mapParent(stringValue(record, "parentUuid"), request.seed.id),
        role,
        createdAt: stringValue(record, "timestamp") ?? request.seed.createdAt,
        blocks,
      }, typeof message.model === "string" ? message.model : request.seed.models[0], request.seed.tokenTotals.input, request.seed.tokenTotals.output);
    });
    // A transcript names its own conversation, its working directory and its
    // branch. Without the session id the archive identified a capture by the
    // hash of the file, so the same conversation captured again after it grew
    // looked like a different session — and then failed to save, because its
    // turns already belonged to the first one. An ongoing session stopped being
    // archived after its first capture.
    const first = records[0]!;
    const nativeSessionId = stringValue(first, "sessionId");
    const cwd = stringValue(first, "cwd");
    const branch = stringValue(first, "gitBranch");
    return {
      kind: "parsed",
      parser: "claude-code:v1:0.2.0",
      sessions: [{
        ...request.seed,
        ...(nativeSessionId ? { source: { ...request.seed.source, nativeSessionId } } : {}),
        ...(cwd || branch ? {
          workspace: {
            ...request.seed.workspace,
            ...(cwd ? { path: cwd } : {}),
            ...(branch ? { branch } : {}),
          },
        } : {}),
        turns,
      }],
    };
  }
}
