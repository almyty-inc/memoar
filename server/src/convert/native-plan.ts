import { createHash } from "node:crypto";
import type { ContentBlock, Session, Turn } from "../../libs/canonical/src/generated.js";
import { textForDegraded, type ConversionReport } from "./types.js";

/**
 * A session as the agent tools replay it: alternating user and assistant
 * messages, every tool call answered by the next message.
 *
 * The canonical session is not in that shape. A Codex or Antigravity turn holds
 * a call and its result side by side in one assistant turn, a Claude Code turn
 * holds the result in the next user turn, and a call can have no result at all
 * when the source was interrupted. Every native writer needs the same answer,
 * so it is computed once here and each writer only spells it.
 */
export type PlanPart =
  | { kind: "text"; text: string; turnId: string; blockId: string }
  | { kind: "image"; mediaType: string; base64?: string; url?: string; turnId: string; blockId: string }
  | { kind: "document"; source: Record<string, unknown>; title?: string; text?: string; turnId: string; blockId: string }
  | { kind: "thinking"; text: string; data: Record<string, unknown>; turnId: string; blockId: string }
  | { kind: "tool_call"; callId: string; name: string; input: Record<string, unknown>; rawArguments?: string; turnId: string; blockId: string }
  | { kind: "tool_result"; callId: string; text: string; isError: boolean; nativeContent?: unknown[]; turnId: string; blockId: string };

export interface PlanMessage {
  role: "user" | "assistant";
  turnIds: string[];
  createdAt: string;
  model?: string;
  parts: PlanPart[];
}

export interface WorkspacePlacement {
  path: string;
  branch?: string;
}

/** The directory the session is written for: the caller's, or the archived one. */
export function placement(session: Session, workspacePath?: string): WorkspacePlacement {
  if (workspacePath) return { path: workspacePath };
  return { path: session.workspace.path, ...(session.workspace.branch ? { branch: session.workspace.branch } : {}) };
}

/** A stable UUID for a record the canonical session has no id for. */
export function derivedUuid(seed: string): string {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A tool's arguments as an object, whichever shape the source stored them in. */
function toolInput(block: ContentBlock): { input: Record<string, unknown>; rawArguments?: string } {
  const data = block.data ?? {};
  const keys = Object.keys(data);
  if (keys.length === 1 && typeof data.arguments === "string") {
    try {
      const parsed = record(JSON.parse(data.arguments));
      if (parsed) return { input: parsed, rawArguments: data.arguments };
    } catch { /* not JSON: a custom tool's free-form input */ }
    return { input: { input: data.arguments }, rawArguments: data.arguments };
  }
  return { input: data };
}

function imagePart(block: ContentBlock): PlanPart | null {
  const base = { turnId: "", blockId: block.id };
  const source = record(block.data?.source);
  if (source?.type === "base64" && typeof source.data === "string") {
    const mediaType = block.mimeType ?? (typeof source.media_type === "string" ? source.media_type : "");
    if (mediaType.startsWith("image/")) return { ...base, kind: "image", mediaType, base64: source.data };
    if (mediaType) return { ...base, kind: "document", source, ...(block.name ? { title: block.name } : {}) };
  }
  if (source?.type === "url" && typeof source.url === "string") {
    return { ...base, kind: "image", mediaType: block.mimeType ?? "image/*", url: source.url };
  }
  const imageUrl = typeof block.data?.imageUrl === "string" ? block.data.imageUrl : block.artifactRef;
  const inline = imageUrl?.match(/^data:([^;,]+);base64,(.+)$/su);
  if (inline) return { ...base, kind: "image", mediaType: inline[1]!, base64: inline[2]! };
  if (imageUrl && /^https?:\/\//u.test(imageUrl) && (block.mimeType ?? "image/").startsWith("image/")) {
    return { ...base, kind: "image", mediaType: block.mimeType ?? "image/*", url: imageUrl };
  }
  return null;
}

/**
 * The blocks of a system turn a target should not replay, and why.
 *
 * A system turn is mostly what the source harness told its own model: Codex's
 * developer instructions, Claude Code's compaction boundaries and summaries,
 * Antigravity's system messages. The target harness injects its own. Replaying
 * the source's would hand the target another tool's rules and file paths as if
 * they were the person's, and a compaction summary repeats turns that are
 * already in the conversion. A file the person attached (Claude Code records
 * an @-mention as a system turn) is theirs, so it is kept as user context.
 */
function isHarnessBlock(turn: Turn, block: ContentBlock): boolean {
  return turn.role === "system" && block.kind !== "attachment";
}

/**
 * Text a harness put in a user turn, which the person never typed.
 *
 * Codex sends AGENTS.md, the environment and the sandbox rules as user
 * messages, and Claude Code wraps reminders and local command echoes the same
 * way. The target's own harness sends its own on resume, so these are dropped
 * like system turns. A block is dropped only when it starts with one of these
 * wrappers and ends with one, so a person's words around one are kept. Codex
 * puts AGENTS.md and the environment in one block, which is why the start and
 * the end are matched independently.
 */
const HARNESS_STARTS = [
  "# AGENTS.md instructions for ",
  "<environment_context>",
  "<user_instructions>",
  "<permissions instructions>",
  "<system-reminder>",
  "<local-command-stdout>",
  "<command-name>",
];
const HARNESS_ENDS = [
  "</INSTRUCTIONS>",
  "</environment_context>",
  "</user_instructions>",
  "</permissions instructions>",
  "</system-reminder>",
  "</local-command-stdout>",
  "</command-args>",
];
const CLAUDE_COMMAND_CAVEAT = "Caveat: The messages below were generated by the user while running local commands.";

/**
 * What the person typed, out of Antigravity's wrapper.
 *
 * Antigravity stores a prompt as `<USER_REQUEST>…</USER_REQUEST>` followed by
 * metadata it generated (the local time, setting changes). Only the request is
 * the person's.
 */
function personText(turn: Turn, text: string): string {
  if (turn.role !== "user") return text;
  const request = text.match(/^\s*<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/u);
  return request ? request[1]! : text;
}

function isHarnessText(turn: Turn, block: ContentBlock): boolean {
  if (turn.role !== "user" || block.kind !== "text" || !block.text) return false;
  const text = block.text.trim();
  if (text.startsWith(CLAUDE_COMMAND_CAVEAT)) return true;
  return HARNESS_STARTS.some((start) => text.startsWith(start)) && HARNESS_ENDS.some((end) => text.endsWith(end));
}

class PlanBuilder {
  readonly messages: PlanMessage[] = [];

  constructor(private readonly report: ConversionReport) {}

  private current(role: PlanMessage["role"], turn: Turn): PlanMessage {
    const last = this.messages.at(-1);
    if (last?.role === role) {
      if (!last.turnIds.includes(turn.id)) last.turnIds.push(turn.id);
      return last;
    }
    const message: PlanMessage = { role, turnIds: [turn.id], createdAt: turn.createdAt, ...(turn.model ? { model: turn.model } : {}), parts: [] };
    this.messages.push(message);
    return message;
  }

  private degrade(turn: Turn, block: ContentBlock, reason: string): PlanPart {
    this.report.degraded.push({ turnId: turn.id, blockId: block.id, kind: block.kind, reason });
    return { kind: "text", text: textForDegraded(block), turnId: turn.id, blockId: block.id };
  }

  add(turn: Turn): void {
    const side: PlanMessage["role"] = turn.role === "assistant" ? "assistant" : "user";
    for (const block of turn.blocks) {
      const ids = { turnId: turn.id, blockId: block.id };
      if (isHarnessBlock(turn, block) || isHarnessText(turn, block)) {
        this.report.dropped.push({ reference: `block:${block.id}`, reason: "source_harness_context" });
        continue;
      }
      switch (block.kind) {
        case "text":
          if (block.text) this.current(side, turn).parts.push({ kind: "text", text: personText(turn, block.text), ...ids });
          break;
        case "thinking":
          this.current("assistant", turn).parts.push({ kind: "thinking", text: block.text ?? "", data: block.data ?? {}, ...ids });
          break;
        case "tool_call":
          this.current("assistant", turn).parts.push({
            kind: "tool_call", callId: block.callId ?? block.id, name: block.name ?? "memoar_tool", ...toolInput(block), ...ids,
          });
          break;
        case "tool_result": {
          const nativeContent = Array.isArray(block.data?.content) ? block.data.content as unknown[] : undefined;
          this.current("user", turn).parts.push({
            kind: "tool_result", callId: block.callId ?? block.id, text: block.text ?? (nativeContent ? "" : JSON.stringify(block.data ?? {})),
            isError: block.data?.isError === true, ...(nativeContent ? { nativeContent } : {}), ...ids,
          });
          break;
        }
        case "attachment": {
          const media = imagePart(block);
          if (media) this.current(side, turn).parts.push({ ...media, ...ids });
          else if (block.text && block.mimeType && !block.artifactRef) {
            // A plain-text document the person pasted. Claude takes it as a
            // document; the others read its text.
            this.current(side, turn).parts.push({
              kind: "document", source: { type: "text", media_type: block.mimeType, data: block.text }, text: block.text,
              ...(block.name ? { title: block.name } : {}), ...ids,
            });
          } else if (block.text) this.current(side, turn).parts.push({ kind: "text", text: block.name ? `${block.name}\n${block.text}` : block.text, ...ids });
          else this.current(side, turn).parts.push(this.degrade(turn, block, "Attachment has no bytes or text to carry"));
          break;
        }
        case "system":
          this.report.dropped.push({ reference: `block:${block.id}`, reason: "source_harness_context" });
          break;
        default:
          this.current(side, turn).parts.push(this.degrade(turn, block, "Target has no native representation for this block"));
      }
    }
  }
}

/**
 * Every call answered by the message after it, and every answer preceded by
 * its call.
 *
 * Both models refuse a history where a call has no result ("tool_use ids were
 * found without tool_result blocks immediately after", "No tool output found
 * for function call"), so an unanswered call is answered here and reported. A
 * result whose call is not in the message before it cannot be attached to
 * anything and is carried as text.
 */
function pairToolCalls(messages: PlanMessage[], report: ConversionReport): PlanMessage[] {
  const paired: PlanMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      const previous = paired.at(-1);
      const open = new Set(previous?.role === "assistant"
        ? previous.parts.filter((part) => part.kind === "tool_call").map((part) => part.callId)
        : []);
      const results: PlanPart[] = [];
      const rest: PlanPart[] = [];
      for (const part of message.parts) {
        if (part.kind !== "tool_result") { rest.push(part); continue; }
        if (open.has(part.callId)) { results.push(part); continue; }
        report.degraded.push({ turnId: part.turnId, blockId: part.blockId, kind: "tool_result", reason: "Tool result has no matching call before it" });
        rest.push({ kind: "text", text: `[Memoar tool_result ${part.callId}] ${part.text}`, turnId: part.turnId, blockId: part.blockId });
      }
      message.parts = [...results, ...rest];
      if (message.parts.length) paired.push(message);
      continue;
    }
    paired.push(message);
    const calls = message.parts.filter((part) => part.kind === "tool_call");
    if (!calls.length) continue;
    const next = messages[index + 1];
    const answered = new Set(next?.role === "user" ? next.parts.filter((part) => part.kind === "tool_result").map((part) => part.callId) : []);
    const missing = calls.filter((call) => !answered.has(call.callId));
    if (!missing.length) continue;
    const synthetic: PlanPart[] = missing.map((call) => {
      report.degraded.push({ turnId: call.turnId, blockId: call.blockId, kind: "tool_call", reason: "No result was recorded for this call; a placeholder result was written" });
      return { kind: "tool_result", callId: call.callId, text: "[Memoar] No result was recorded for this call.", isError: true, turnId: call.turnId, blockId: call.blockId };
    });
    if (next?.role === "user") next.parts.unshift(...synthetic);
    else paired.push({ role: "user", turnIds: [...message.turnIds], createdAt: message.createdAt, parts: synthetic });
  }
  return paired;
}

export function planSession(session: Session, report: ConversionReport): PlanMessage[] {
  const builder = new PlanBuilder(report);
  for (const turn of session.turns) {
    builder.add(turn);
  }
  return pairToolCalls(builder.messages.filter((message) => message.parts.length), report);
}

/**
 * Thinking a target cannot replay, removed and reported.
 *
 * A reasoning block is only valid for the vendor that signed or encrypted it.
 * Claude rejects a thinking block whose signature it did not issue, and an
 * OpenAI reasoning item is opaque ciphertext to anyone else.
 */
export function dropThinking(messages: PlanMessage[], report: ConversionReport, keep: (part: Extract<PlanPart, { kind: "thinking" }>) => boolean): PlanMessage[] {
  for (const message of messages) {
    message.parts = message.parts.filter((part) => {
      if (part.kind !== "thinking" || keep(part)) return true;
      report.dropped.push({ reference: `block:${part.blockId}`, reason: "reasoning_not_portable" });
      return false;
    });
  }
  return messages.filter((message) => message.parts.length);
}

/** Blocks that reached the target in their own shape, not as attributed text. */
export function countMapped(messages: PlanMessage[], report: ConversionReport): void {
  const degraded = new Set(report.degraded.map((entry) => entry.blockId));
  report.mapped += messages.reduce((total, message) => total + message.parts.filter((part) => !degraded.has(part.blockId)).length, 0);
}
