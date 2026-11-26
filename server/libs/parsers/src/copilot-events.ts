import type { ContentBlock, Session, Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, sessionModels, stringValue } from "./common.js";
import type { ParseResult, SessionSeed } from "./types.js";
import { parserVersion } from "./versions.js";

type Event = Record<string, unknown>;

/**
 * GitHub Copilot CLI's `~/.copilot/session-state/<id>/events.jsonl`.
 *
 * One line per session event, `{id, parentId, timestamp, type, data}`, as the
 * Copilot SDK publishes them (`github/copilot-sdk`,
 * `nodejs/src/generated/session-events.ts`). VS Code's agent host runs the
 * same engine and writes the same file. Nobody here has a populated one, so
 * this follows the published schema and nothing else: what it reads is named
 * below, and every other event type is left alone.
 *
 * - `session.start`: `sessionId`, `selectedModel`, `context.cwd`
 * - `session.model_change`: `newModel`; `session.title_changed`: `title`
 * - `user.message`: `content`, `attachments`
 * - `assistant.message`: `content`, `reasoningText`, `encryptedContent`,
 *   `toolRequests[]`, `model`; `assistant.reasoning`: `content`
 * - `tool.execution_start` and `tool.execution_complete`, paired by `toolCallId`
 * - `session.compaction_complete`: `summaryContent`; `session.error`: `message`
 */
const MESSAGE_TYPES = new Set(["user.message", "assistant.message"]);

/** Whether these lines are the CLI's event stream. Detection asks the same. */
export function isCopilotEventLog(records: readonly Event[]): boolean {
  return records.some((record) => typeof record.type === "string"
    && isRecord(record.data)
    && typeof record.timestamp === "string"
    && (record.type === "session.start" || MESSAGE_TYPES.has(record.type)));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseCopilotEvents(events: readonly Event[], seed: SessionSeed, raw: Uint8Array): ParseResult {
  const turns: Turn[] = [];
  let ordinal = 0;
  const mint = () => incrementUuid(seed.id, 0x4000000 + (ordinal += 1));
  let model: string | undefined;
  let title: string | null = null;
  let nativeSessionId: string | null = null;
  let cwd: string | null = null;

  const newTurn = (role: Turn["role"], createdAt: string): Turn => {
    const turn: Turn = {
      id: incrementUuid(seed.id, turns.length + 1),
      ordinal: turns.length,
      parentId: turns.at(-1)?.id ?? null,
      role,
      createdAt,
      blocks: [],
    };
    turns.push(turn);
    return turn;
  };
  const assistant = (createdAt: string, named?: string | null): Turn => {
    const last = turns.at(-1);
    const turn = last?.role === "assistant" ? last : newTurn("assistant", createdAt);
    const chosen = named ?? model;
    if (chosen && !turn.model) turn.model = chosen;
    return turn;
  };
  const hasCall = (turn: Turn, callId: string) => turn.blocks.some((block) => block.kind === "tool_call" && block.callId === callId);

  for (const event of events) {
    if (event.ephemeral === true || !isRecord(event.data)) continue;
    const data = event.data;
    const at = stringValue(event, "timestamp") ?? seed.createdAt;
    switch (event.type) {
      case "session.start": {
        nativeSessionId = stringValue(data, "sessionId") ?? nativeSessionId;
        model = stringValue(data, "selectedModel") ?? model;
        cwd = isRecord(data.context) ? stringValue(data.context, "cwd") : cwd;
        break;
      }
      case "session.resume":
        cwd = isRecord(data.context) ? stringValue(data.context, "cwd") ?? cwd : cwd;
        break;
      case "session.model_change":
        model = stringValue(data, "newModel") ?? model;
        break;
      case "session.title_changed":
        title = stringValue(data, "title") ?? title;
        break;
      case "user.message": {
        const turn = newTurn("user", at);
        const prompt = text(data.content);
        if (prompt) turn.blocks.push({ id: mint(), kind: "text", text: prompt });
        for (const attachment of Array.isArray(data.attachments) ? data.attachments.filter(isRecord) : []) {
          const name = stringValue(attachment, "displayName") ?? stringValue(attachment, "path") ?? stringValue(attachment, "type");
          turn.blocks.push({ id: mint(), kind: "attachment", ...(name ? { name } : {}), data: attachment });
        }
        break;
      }
      case "assistant.reasoning": {
        const thought = text(data.content);
        if (thought) assistant(at, stringValue(data, "model")).blocks.push({ id: mint(), kind: "thinking", text: thought });
        break;
      }
      case "assistant.message": {
        const turn = assistant(at, stringValue(data, "model"));
        const thought = text(data.reasoningText);
        if (thought && !turn.blocks.some((block) => block.kind === "thinking" && block.text === thought)) {
          turn.blocks.push({ id: mint(), kind: "thinking", text: thought });
        }
        const encrypted = text(data.encryptedContent) ?? text(data.reasoningOpaque);
        if (encrypted) turn.blocks.push({ id: mint(), kind: "thinking", data: { encrypted } });
        const reply = text(data.content);
        if (reply) turn.blocks.push({ id: mint(), kind: "text", text: reply });
        for (const request of Array.isArray(data.toolRequests) ? data.toolRequests.filter(isRecord) : []) {
          const callId = stringValue(request, "toolCallId") ?? mint();
          turn.blocks.push(toolCall(mint(), stringValue(request, "name"), callId, request.arguments));
        }
        break;
      }
      case "tool.execution_start": {
        const callId = stringValue(data, "toolCallId");
        const turn = assistant(at);
        if (callId && !hasCall(turn, callId)) turn.blocks.push(toolCall(mint(), stringValue(data, "toolName"), callId, data.arguments));
        break;
      }
      case "tool.execution_complete": {
        const callId = stringValue(data, "toolCallId");
        if (callId) assistant(at).blocks.push(toolResult(mint(), callId, data));
        break;
      }
      case "session.compaction_complete": {
        const summary = text(data.summaryContent);
        if (summary) newTurn("system", at).blocks.push({ id: mint(), kind: "system", name: "compaction", text: summary });
        break;
      }
      case "session.error": {
        const message = text(data.message);
        if (message) newTurn("system", at).blocks.push({ id: mint(), kind: "error", text: message, data });
        break;
      }
      default:
        break;
    }
  }

  const kept = turns.filter((turn) => turn.blocks.length > 0).map((turn, index, all) => ({
    ...turn,
    ordinal: index,
    parentId: index === 0 ? null : all[index - 1]!.id,
  }));
  if (!kept.some((turn) => turn.role === "user" || turn.role === "assistant")) {
    if (nativeSessionId !== null) {
      return { kind: "empty", parser: parserVersion("copilot"), diagnostic: "copilot cli session holds no messages" };
    }
    return { kind: "unknown", diagnostic: "copilot cli event log holds no session.start and no messages", raw };
  }
  const session: Session = {
    ...seed,
    ...(nativeSessionId ? { source: { ...seed.source, nativeSessionId } } : {}),
    ...(title ? { title } : {}),
    ...(cwd ? { workspace: { ...seed.workspace, path: cwd } } : {}),
    models: sessionModels(seed.models, kept, model),
    turns: kept,
  };
  return { kind: "parsed", parser: parserVersion("copilot"), sessions: [session] };
}

function toolCall(id: string, name: string | null, callId: string, args: unknown): ContentBlock {
  return { id, kind: "tool_call", name: name ?? "tool", callId, data: isRecord(args) ? args : args === undefined ? {} : { arguments: args } };
}

/** `result.content` or `error.message`, and whether it failed. */
function toolResult(id: string, callId: string, data: Record<string, unknown>): ContentBlock {
  const result = isRecord(data.result) ? data.result : null;
  const error = isRecord(data.error) ? data.error : null;
  const output = (result ? text(result.content) : null) ?? (error ? text(error.message) : null);
  const extra: Record<string, unknown> = {};
  // What the person was shown, when it says more than what the model was given.
  const detailed = result ? text(result.detailedContent) : null;
  if (detailed && detailed !== output) extra.detailedContent = detailed;
  if (data.success === false) extra.isError = true;
  if (Array.isArray(data.fileEdits)) extra.fileEdits = data.fileEdits;
  return { id, kind: "tool_result", callId, ...(output ? { text: output } : {}), ...(Object.keys(extra).length > 0 ? { data: extra } : {}) };
}
