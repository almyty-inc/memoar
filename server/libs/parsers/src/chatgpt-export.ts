import type { ContentBlock, Session, Turn } from "../../canonical/src/generated.js";
import { readArchiveEntry } from "./archive.js";
import { incrementUuid, isRecord, stringValue, withModelAndTokens } from "./common.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

/** ChatGPT exports arrive as a ZIP whose payload is this file. */
const CONVERSATIONS_ENTRY = "conversations.json";

interface MappingNode {
  readonly id: string;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly message: Record<string, unknown> | null;
}

function readMapping(value: unknown): Map<string, MappingNode> {
  const nodes = new Map<string, MappingNode>();
  if (!isRecord(value)) return nodes;
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    nodes.set(id, {
      id,
      parent: typeof entry.parent === "string" ? entry.parent : null,
      children: Array.isArray(entry.children) ? entry.children.filter((child): child is string => typeof child === "string") : [],
      message: isRecord(entry.message) ? entry.message : null,
    });
  }
  return nodes;
}

/**
 * ChatGPT stores a conversation as a tree, not a list: regenerated answers
 * become sibling branches. Depth-first from the roots keeps each branch
 * contiguous and preserves the order a reader saw, which a plain
 * Object.values() over the mapping does not guarantee.
 */
function depthFirst(nodes: Map<string, MappingNode>): MappingNode[] {
  const roots = [...nodes.values()].filter((node) => node.parent === null || !nodes.has(node.parent));
  const ordered: MappingNode[] = [];
  const visited = new Set<string>();
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    ordered.push(node);
    for (const childId of [...node.children].reverse()) {
      const child = nodes.get(childId);
      if (child) stack.push(child);
    }
  }
  return ordered;
}

function role(message: Record<string, unknown>): Turn["role"] {
  const author = isRecord(message.author) ? stringValue(message.author, "role") : null;
  return author === "assistant" || author === "tool" || author === "system" ? author : "user";
}

/**
 * Distance block ids sit from the session id.
 *
 * Turn ids come from the export's own node ids, which sit near the session id,
 * so numbering blocks upward from either lands on a turn id: a session …140
 * with turns …141 and …142 minted a block …142. Blocks get their own range and
 * a counter that runs for the whole session, which also keeps them unique when
 * one turn is assembled from several export nodes — numbering per node gave
 * every step of an answer the same block id.
 */
const BLOCK_ID_BASE = 0x2000000;

/**
 * `parts` entries are strings for ordinary text and objects for images and
 * other attachments. content_type distinguishes the model's private reasoning
 * from what it said, and a message addressed to a tool rather than to the user
 * is a call, which the canonical model keeps as separate block kinds.
 */
function blocks(message: Record<string, unknown>, mint: () => string): ContentBlock[] {
  const content = isRecord(message.content) ? message.content : null;
  if (!content) return [];
  const contentType = stringValue(content, "content_type") ?? "text";
  const produced: ContentBlock[] = [];

  const recipient = stringValue(message, "recipient");
  if (contentType === "code" && recipient && recipient !== "all") {
    const argumentText = Array.isArray(content.parts)
      ? content.parts.filter((part): part is string => typeof part === "string").join("")
      : stringValue(content, "text") ?? "";
    let data: Record<string, unknown> = {};
    try {
      const decoded: unknown = JSON.parse(argumentText);
      if (isRecord(decoded)) data = decoded;
    } catch {
      // Arguments that are not JSON are still worth keeping verbatim.
      if (argumentText.length > 0) data = { arguments: argumentText };
    }
    const metadata = isRecord(message.metadata) ? message.metadata : {};
    const callId = stringValue(metadata, "call_id") ?? stringValue(message, "id") ?? mint();
    produced.push({ id: mint(), kind: "tool_call", name: recipient, callId, data });
    return produced;
  }

  const kind = contentType === "thoughts" || contentType === "reasoning_recap" ? "thinking" : "text";
  const parts = Array.isArray(content.parts) ? content.parts : [];
  for (const part of parts) {
    const text = typeof part === "string" ? part : isRecord(part) ? stringValue(part, "text") : null;
    if (text === null || text.length === 0) continue;
    produced.push({ id: mint(), kind, text });
  }
  return produced;
}

function timestamp(message: Record<string, unknown> | null, fallback: string): string {
  const seconds = message?.create_time;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return fallback;
  return new Date(seconds * 1000).toISOString();
}

export class ChatgptExportParser implements VersionedParser {
  readonly source = "chatgpt-export";
  readonly versions = ["2026-08"] as const;

  parse(request: ParseRequest): ParseResult {
    try {
      const decoded = JSON.parse(readArchiveEntry(request.raw, CONVERSATIONS_ENTRY)) as unknown;
      // A single-conversation export is an object; a full account export is an array.
      const conversations = Array.isArray(decoded) ? decoded : [decoded];
      const sessions: Session[] = [];
      for (const [index, conversation] of conversations.entries()) {
        if (!isRecord(conversation)) continue;
        const session = this.toSession(conversation, index, request);
        if (session) sessions.push(session);
      }
      if (sessions.length === 0) {
        return { kind: "unknown", diagnostic: "chatgpt-export contained no conversations with messages", raw: request.raw };
      }
      return { kind: "parsed", parser: "chatgpt-export:2026-08:0.2.0", sessions };
    } catch (error) {
      return {
        kind: "unknown",
        diagnostic: `chatgpt-export decode failed: ${error instanceof Error ? error.message : String(error)}`,
        raw: request.raw,
      };
    }
  }

  private toSession(conversation: Record<string, unknown>, index: number, request: ParseRequest): Session | null {
    const nodes = readMapping(conversation.mapping);
    const seed = request.seed;
    const ordered = depthFirst(nodes).filter((node) => node.message !== null);
    // The mapping's synthetic root carries no author content; dropping empty
    // nodes keeps ordinals contiguous rather than leaving gaps in the timeline.
    // A probe mint: this only asks whether a node has content, so it must not
    // consume ids that the real numbering would then skip.
    const kept = ordered.filter((node) => blocks(node.message!, () => "probe").length > 0);
    if (kept.length === 0) return null;

    let blockOrdinal = 0;
    const mint = () => incrementUuid(seed.id, BLOCK_ID_BASE + (blockOrdinal += 1));

    // ChatGPT writes one node per step, so a single answer arrives as a run of
    // assistant nodes: private reasoning, then any tool calls, then the reply.
    // Left as they are, one answer becomes three turns, which reads nothing
    // like the same conversation captured from any other agent. A contiguous
    // run by the same non-user author is one turn whose blocks are the steps.
    const groups: MappingNode[][] = [];
    for (const node of kept) {
      const previous = groups.at(-1);
      const author = role(node.message!);
      const continues = previous !== undefined && author !== "user" && role(previous[0]!.message!) === author;
      if (continues) previous.push(node);
      else groups.push([node]);
    }

    // A run is named by its last step: that is the reply, and it is the node
    // the following message points at. Naming it after the first step would
    // identify the turn by private reasoning and break every parent link.
    const representative = new Map<string, string>();
    for (const group of groups) {
      const head = group.at(-1)!.id;
      for (const step of group) representative.set(step.id, head);
    }

    const turns = groups.map((group, ordinal): Turn => {
      const node = group.at(-1)!;
      const message = node.message!;
      // Reattach across dropped nodes so the thread stays connected instead of
      // pointing at a parent that is not in the archive.
      let parentId: string | null = group[0]!.parent;
      while (parentId !== null && !representative.has(parentId)) parentId = nodes.get(parentId)?.parent ?? null;
      parentId = parentId === null ? null : representative.get(parentId) ?? null;
      // The model is declared on the step that produced the reply, not on the
      // reasoning that preceded it, so it is taken from whichever step in the
      // run names one rather than from the step that happens to be first.
      const model = group
        .map((step) => (isRecord(step.message?.metadata) ? stringValue(step.message.metadata, "model_slug") : null))
        .findLast((slug) => slug !== null) ?? null;
      const turnBlocks = group.flatMap((step) => blocks(step.message!, mint));
      return withModelAndTokens({
        id: node.id,
        ordinal,
        parentId,
        role: role(message),
        createdAt: timestamp(message, seed.createdAt),
        blocks: turnBlocks,
      }, model ?? seed.models[0], seed.tokenTotals.input, seed.tokenTotals.output);
    });

    const nativeSessionId = stringValue(conversation, "conversation_id") ?? stringValue(conversation, "id") ?? `chatgpt-${index}`;
    const title = stringValue(conversation, "title");
    return {
      ...seed,
      id: index === 0 ? seed.id : incrementUuid(seed.id, index),
      source: { ...seed.source, nativeSessionId },
      ...(title ? { title } : {}),
      createdAt: timestamp(kept[0]!.message, seed.createdAt),
      updatedAt: timestamp(kept.at(-1)!.message, seed.updatedAt),
      turns,
    };
  }
}
