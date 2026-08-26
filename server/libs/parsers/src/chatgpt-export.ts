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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Block ids are derived from the turn id, but only when that id is a UUID we
 * can do arithmetic on. ChatGPT's are, yet an export with any other id shape
 * must not cost the reader the whole conversation, so those fall back to the
 * seed and stay unique through the caller's running offset.
 */
function blockId(turnId: string, index: number, fallbackBase: string, fallbackOffset: number): string {
  return UUID.test(turnId) ? incrementUuid(turnId, index) : incrementUuid(fallbackBase, fallbackOffset);
}

/**
 * `parts` entries are strings for ordinary text and objects for images and
 * other attachments. content_type distinguishes the model's private reasoning
 * from what it said, which the canonical model keeps as separate block kinds.
 */
function blocks(message: Record<string, unknown>, turnId: string, fallbackBase = turnId, fallbackStart = 0): ContentBlock[] {
  const content = isRecord(message.content) ? message.content : null;
  if (!content) return [];
  const contentType = stringValue(content, "content_type") ?? "text";
  const kind = contentType === "thoughts" || contentType === "reasoning_recap" ? "thinking" : "text";
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const produced: ContentBlock[] = [];
  for (const part of parts) {
    const text = typeof part === "string" ? part : isRecord(part) ? stringValue(part, "text") : null;
    if (text === null || text.length === 0) continue;
    produced.push({ id: blockId(turnId, produced.length + 1, fallbackBase, fallbackStart + produced.length + 1), kind, text });
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
    const kept = ordered.filter((node) => blocks(node.message!, node.id, seed.id).length > 0);
    if (kept.length === 0) return null;

    const retained = new Set(kept.map((node) => node.id));
    let blockOffset = 0;
    const turns = kept.map((node, ordinal): Turn => {
      const message = node.message!;
      // Reattach across dropped nodes so the thread stays connected instead of
      // pointing at a parent that is not in the archive.
      let parentId: string | null = node.parent;
      while (parentId !== null && !retained.has(parentId)) parentId = nodes.get(parentId)?.parent ?? null;
      const model = isRecord(message.metadata) ? stringValue(message.metadata, "model_slug") : null;
      const turnBlocks = blocks(message, node.id, seed.id, blockOffset);
      blockOffset += turnBlocks.length;
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
