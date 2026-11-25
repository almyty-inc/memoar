import type { ContentBlock, Turn } from "../../canonical/src/generated.js";
import { BUILT_IN_CALLS, CODEX_BOOKKEEPING_ITEMS, messageBlocks, outputBlock, reasoningBlock, toolData } from "./codex-items.js";
import { incrementUuid, isRecord, mostlyJsonLines, stringValue, withModelAndTokens } from "./common.js";
import type { ParseRequest, ParseResult, SessionSeed, VersionedParser } from "./types.js";
import { parserVersion } from "./versions.js";

/** Rollout lines that are not response items: turn context, UI events, meta. */
const RESPONSE_ITEM = "response_item";

/**
 * A compaction rewrites the context, and its summary is the only account of
 * what the model kept. `replacement_history` restates items the rollout already
 * holds, so it is not read again.
 */
const COMPACTED = "compacted";

/**
 * Codex writes a rollout as an append-only stream of response items, one per
 * step the model took: the message it produced, the reasoning behind it, and
 * every tool call and result. Only `message` items carry a role.
 *
 * Treating each item as a turn produced a transcript of hundreds of authorless
 * turns holding nothing — a real session read as 762 turns of which 740 were
 * empty. Reasoning and tool activity belong to the assistant turn they were
 * part of, so they are collected into it as blocks.
 */
export class CodexRolloutV1Parser implements VersionedParser {
  readonly source = "codex";
  readonly versions = ["rollout-v1"] as const;

  parse(request: ParseRequest): ParseResult {
    // Line by line: one line broken in transit is not a broken rollout.
    const records = mostlyJsonLines(request.raw);
    const meta = records?.find((record) => record.type === "session_meta");
    const events = records?.filter((record) => (record.type === RESPONSE_ITEM || record.type === COMPACTED) && isRecord(record.payload)) ?? [];
    if (!meta || !isRecord(meta.payload) || events.length === 0) {
      return { kind: "unknown", diagnostic: "codex rollout-v1 requires session_meta followed by response_item events", raw: request.raw };
    }

    // The rollout's own id names the session in Codex, not in the archive: the
    // canonical id is the UUID the archive assigned. Putting the native id in
    // that field also meant doing arithmetic on it to derive turn ids, which
    // throws for any id that is not hexadecimal.
    const nativeSessionId = stringValue(meta.payload, "id");
    const turns: Turn[] = [];
    let blockOrdinal = 0;
    const mintBlock = () => incrementUuid(request.seed.id, 0x4000000 + (blockOrdinal += 1));

    const newTurn = (role: Turn["role"], createdAt: string, blocks: ContentBlock[]): Turn => {
      const turn: Turn = {
        id: incrementUuid(request.seed.id, turns.length + 1),
        ordinal: turns.length,
        parentId: turns.at(-1)?.id ?? null,
        role,
        createdAt,
        blocks,
      };
      turns.push(turn);
      return turn;
    };

    /** The assistant turn currently being assembled, opened on demand. */
    const openAssistant = (createdAt: string): Turn => {
      const last = turns.at(-1);
      if (last && last.role === "assistant") return last;
      const turn = withModelAndTokens(newTurn("assistant", createdAt, []), request.seed.models[0], request.seed.tokenTotals.input, request.seed.tokenTotals.output);
      turns[turns.length - 1] = turn;
      return turn;
    };

    for (const record of events) {
      const payload = record.payload as Record<string, unknown>;
      const createdAt = stringValue(record, "timestamp") ?? request.seed.createdAt;
      if (record.type === COMPACTED) {
        const summary = stringValue(payload, "message");
        if (summary) newTurn("system", createdAt, [{ id: mintBlock(), kind: "system", name: "compaction", text: summary }]);
        continue;
      }
      // Older rollouts do not stamp a type on every item; one carrying a role
      // and content is a message whether or not it says so.
      const type = stringValue(payload, "type")
        ?? (stringValue(payload, "role") !== null && payload.content !== undefined ? "message" : null);

      if (type === "message") {
        const roleValue = stringValue(payload, "role");
        const blocks = messageBlocks(payload.content, mintBlock);
        if (blocks.length === 0) continue;
        if (roleValue === "assistant") {
          openAssistant(createdAt).blocks.push(...blocks);
          continue;
        }
        // Developer and system messages are the harness instructing the model.
        // They were filed as things the person typed.
        newTurn(roleValue === "developer" || roleValue === "system" ? "system" : "user", createdAt, blocks);
        continue;
      }

      if (type === "reasoning") {
        const block = reasoningBlock(payload, mintBlock);
        if (block) openAssistant(createdAt).blocks.push(block);
        continue;
      }

      if (type === "function_call" || type === "custom_tool_call" || (type !== null && BUILT_IN_CALLS[type])) {
        const namespace = stringValue(payload, "namespace");
        openAssistant(createdAt).blocks.push({
          id: mintBlock(),
          kind: "tool_call",
          name: stringValue(payload, "name") ?? BUILT_IN_CALLS[type] ?? "tool",
          callId: stringValue(payload, "call_id") ?? mintBlock(),
          data: toolData(payload),
          ...(namespace ? { ext: { namespace } } : {}),
        });
        continue;
      }

      if (type === "function_call_output" || type === "custom_tool_call_output") {
        openAssistant(createdAt).blocks.push(outputBlock(payload, mintBlock));
        continue;
      }

      if (type === "compaction") {
        const encrypted = stringValue(payload, "encrypted_content");
        if (encrypted) newTurn("system", createdAt, [{ id: mintBlock(), kind: "system", name: "compaction", data: { encrypted } }]);
        continue;
      }
      if (type === null || CODEX_BOOKKEEPING_ITEMS.has(type)) continue;
      // An item type added since this was written is kept whole rather than
      // dropped: losing what a rollout recorded is the worse answer.
      openAssistant(createdAt).blocks.push({ id: mintBlock(), kind: "system", name: type, data: payload, ext: { nativeKind: type } });
    }

    const withOrdinals = turns
      .filter((turn) => turn.blocks.length > 0)
      .map((turn, ordinal) => ({ ...turn, ordinal }));

    // A rollout with nothing but an encrypted compaction and settings, like a
    // guardian thread, holds no conversation, and is refused with its bytes.
    if (!withOrdinals.some((turn) => turn.role === "user" || turn.role === "assistant")) {
      return { kind: "unknown", diagnostic: "codex rollout-v1 stream contained no readable messages", raw: request.raw };
    }
    return {
      kind: "parsed",
      parser: parserVersion(this.source),
      sessions: [{
        ...(request.seed satisfies SessionSeed),
        ...(nativeSessionId ? { source: { ...request.seed.source, nativeSessionId } } : {}),
        turns: withOrdinals,
      }],
    };
  }
}
