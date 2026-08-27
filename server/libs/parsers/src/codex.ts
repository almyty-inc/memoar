import type { ContentBlock, Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, parseJsonLines, stringValue, withModelAndTokens } from "./common.js";
import type { ParseRequest, ParseResult, SessionSeed, VersionedParser } from "./types.js";

/** Rollout lines that are not response items: turn context, UI events, meta. */
const RESPONSE_ITEM = "response_item";

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => (isRecord(entry) ? stringValue(entry, "text") ?? "" : typeof entry === "string" ? entry : ""))
    .filter((text) => text.length > 0)
    .join("");
}

/** Decodes tool arguments, keeping them verbatim when they are not JSON. */
function toolData(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = stringValue(payload, "arguments") ?? stringValue(payload, "input");
  if (raw === null) return isRecord(payload.input) ? payload.input : {};
  try {
    const decoded: unknown = JSON.parse(raw);
    if (isRecord(decoded)) return decoded;
  } catch {
    // Not JSON; the text is still what the model asked for.
  }
  return { arguments: raw };
}

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
    const records = parseJsonLines(request.raw);
    const meta = records?.find((record) => record.type === "session_meta");
    const events = records?.filter((record) => record.type === RESPONSE_ITEM && isRecord(record.payload)) ?? [];
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

    /** The assistant turn currently being assembled, opened on demand. */
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

    for (const record of events) {
      const payload = record.payload as Record<string, unknown>;
      // Older rollouts do not stamp a type on every item; one carrying a role
      // and content is a message whether or not it says so.
      const type = stringValue(payload, "type")
        ?? (stringValue(payload, "role") !== null && payload.content !== undefined ? "message" : null);
      const createdAt = stringValue(record, "timestamp") ?? request.seed.createdAt;

      if (type === "message") {
        const role = stringValue(payload, "role") === "assistant" ? "assistant" : "user";
        const text = textFromContent(payload.content);
        if (text.length === 0) continue;
        const block: ContentBlock = { id: mintBlock(), kind: "text", text };
        if (role === "assistant") {
          openAssistant(createdAt).blocks.push(block);
          continue;
        }
        turns.push({
          id: incrementUuid(request.seed.id, turns.length + 1),
          ordinal: turns.length,
          parentId: turns.at(-1)?.id ?? null,
          role: "user",
          createdAt,
          blocks: [block],
        });
        continue;
      }

      if (type === "reasoning") {
        // The plain summary is what a reader can use; encrypted_content is
        // opaque by design and is deliberately not carried into the archive.
        const text = textFromContent(payload.summary) || textFromContent(payload.content);
        if (text.length === 0) continue;
        openAssistant(createdAt).blocks.push({ id: mintBlock(), kind: "thinking", text });
        continue;
      }

      if (type === "function_call" || type === "custom_tool_call") {
        openAssistant(createdAt).blocks.push({
          id: mintBlock(),
          kind: "tool_call",
          name: stringValue(payload, "name") ?? "tool",
          callId: stringValue(payload, "call_id") ?? mintBlock(),
          data: toolData(payload),
        });
        continue;
      }

      if (type === "function_call_output" || type === "custom_tool_call_output") {
        const output = stringValue(payload, "output") ?? JSON.stringify(payload.output ?? "");
        openAssistant(createdAt).blocks.push({
          id: mintBlock(),
          kind: "tool_result",
          callId: stringValue(payload, "call_id") ?? mintBlock(),
          text: output,
        });
        continue;
      }
      // Anything else is a step Codex records for itself; rollouts gain new
      // item types and losing a transcript to one would be far worse.
    }

    const withOrdinals = turns
      .filter((turn) => turn.blocks.length > 0)
      .map((turn, ordinal) => ({ ...turn, ordinal }));

    if (withOrdinals.length === 0) {
      return { kind: "unknown", diagnostic: "codex rollout-v1 stream contained no readable messages", raw: request.raw };
    }
    return {
      kind: "parsed",
      parser: "codex:rollout-v1:0.2.0",
      sessions: [{
        ...(request.seed satisfies SessionSeed),
        ...(nativeSessionId ? { source: { ...request.seed.source, nativeSessionId } } : {}),
        turns: withOrdinals,
      }],
    };
  }
}
