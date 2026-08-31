import type { ContentBlock, Session, Turn } from "../../canonical/src/generated.js";
import { derivedBlockId, epochToIso, incrementUuid, isRecord, parseBlock, stringValue } from "./common.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

/** Keys an exported task might carry its messages under. */
const MESSAGE_KEYS = ["apiConversationHistory", "history", "messages", "conversation"];

function messageArray(input: unknown): unknown[] | null {
  if (Array.isArray(input)) return input;
  if (!isRecord(input)) return null;
  for (const key of MESSAGE_KEYS) {
    const value = input[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/**
 * Roo Code and Kilo Code, which share an ancestry, store a task as
 * `tasks/<taskId>/api_conversation_history.json`: an array of Anthropic
 * message params, each `{ role, content }` where content is either a string or
 * the usual tool_use / tool_result / thinking / text blocks. Roo adds `ts` and
 * a `reasoning` item type of its own.
 *
 * The parser previously expected an object with a `history` array of messages
 * carrying `parts` and a `parentId` — a shape neither tool has ever written.
 */
export class TaskHistoryParser implements VersionedParser {
  readonly versions = ["v1"] as const;

  constructor(readonly source: string) {}

  parse(request: ParseRequest): ParseResult {
    try {
      const input = JSON.parse(Buffer.from(request.raw).toString("utf8")) as unknown;
      const messages = messageArray(input);
      if (!messages) {
        return {
          kind: "unknown",
          diagnostic: `${this.source} v1 requires an api_conversation_history array`,
          raw: request.raw,
        };
      }

      const envelope = isRecord(input) ? input : {};
      const seed = request.seed;
      let previousId: string | null = null;

      const turns = messages.flatMap((message, ordinal): Turn[] => {
        if (!isRecord(message)) return [];
        const role = stringValue(message, "role") === "assistant" ? "assistant" : "user";
        const id = stringValue(message, "id") ?? incrementUuid(seed.id, ordinal + 1);

        // Anthropic allows a bare string as well as a block array.
        const content = message.content;
        const rawBlocks = typeof content === "string"
          ? [{ type: "text", text: content }]
          : Array.isArray(content) ? content : [];
        const blocks = rawBlocks
          .map((block, index) => parseBlock(block, derivedBlockId(id, index + 1, seed.id, ordinal)))
          .filter((block): block is ContentBlock => block !== null && (block.kind !== "text" || (block.text ?? "").length > 0));
        if (blocks.length === 0) return [];

        const turn: Turn = {
          id,
          ordinal,
          // A task history is a flat list, so the order is the parent chain.
          parentId: previousId,
          role,
          createdAt: epochToIso(message.ts, seed.createdAt),
          blocks,
        };
        previousId = id;
        return [turn];
      }).map((turn, ordinal) => ({ ...turn, ordinal }));

      if (turns.length === 0) {
        return { kind: "unknown", diagnostic: `${this.source} v1 task held no readable messages`, raw: request.raw };
      }

      const nativeSessionId = stringValue(envelope, "taskId") ?? stringValue(envelope, "id");
      const title = stringValue(envelope, "title") ?? stringValue(envelope, "task");
      const session: Session = {
        ...seed,
        ...(nativeSessionId ? { source: { ...seed.source, nativeSessionId } } : {}),
        ...(title ? { title } : {}),
        turns,
      };
      return { kind: "parsed", parser: `${this.source}:v1:0.2.0`, sessions: [session] };
    } catch (error) {
      return {
        kind: "unknown",
        diagnostic: `${this.source} v1 decode failed: ${error instanceof Error ? error.message : String(error)}`,
        raw: request.raw,
      };
    }
  }
}
