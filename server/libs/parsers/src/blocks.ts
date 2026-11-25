import type { ContentBlock, ContentBlockKind } from "../../canonical/src/generated.js";
import { isRecord, isUuid, stringValue } from "./common.js";
import { mediaBlock } from "./media.js";

/**
 * Vendor names for block kinds that mean something the canonical model already
 * has. Without these, a Claude Code transcript stored every one of its tool
 * calls as text carrying an ext.nativeKind note — 1,480 of them in a single
 * real session — so the archive rendered tool use as prose.
 */
const KIND_ALIASES: Readonly<Record<string, ContentBlockKind>> = {
  tool_use: "tool_call",
  server_tool_use: "tool_call",
  mcp_tool_use: "tool_call",
  toolRequest: "tool_call",
  toolResponse: "tool_result",
  tool_request: "tool_call",
  tool_response: "tool_result",
  toolu: "tool_call",
  function_call: "tool_call",
  tool_output: "tool_result",
  function_call_output: "tool_result",
  image: "attachment",
  input_image: "attachment",
  document: "attachment",
  input_text: "text",
  output_text: "text",
  thought: "thinking",
  reasoning: "thinking",
  redacted_thinking: "thinking",
};

const kinds = new Set<ContentBlockKind>(["text", "thinking", "tool_call", "tool_result", "diff", "artifact", "attachment", "system", "error"]);

/** Anthropic's server tools answer with `web_search_tool_result`, `code_execution_tool_result` and kin. */
function aliasFor(type: string): string {
  if (KIND_ALIASES[type]) return KIND_ALIASES[type];
  return type.endsWith("_tool_result") ? "tool_result" : type;
}

const TEXT_ITEMS = new Set(["text", "input_text", "output_text"]);

/** A content item that is only prose, which a block's `text` holds whole. */
function isTextItem(item: unknown): boolean {
  if (typeof item === "string") return true;
  return isRecord(item) && TEXT_ITEMS.has(stringValue(item, "type") ?? "") && typeof item.text === "string"
    && Object.keys(item).every((key) => key === "type" || key === "text" || key === "cache_control");
}

/**
 * The prose a content value carries: the string itself, or the text items of an
 * array joined in order. Null when it holds none.
 */
export function textOfContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = (content as unknown[])
    .map((item) => (typeof item === "string" ? item : isRecord(item) ? stringValue(item, "text") : null))
    .filter((text): text is string => text !== null);
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * A tool's answer, whatever shape it came in.
 *
 * Anthropic writes `{tool_use_id, content, is_error}`, where content is a
 * string or an array of text, image, document and tool_reference items. Only
 * the call id was kept: on dev 38,429 of 45,703 tool results held no text at
 * all, so every test run and file read an agent saw was missing. The prose goes
 * into `text`, the error flag and anything that is not prose into `data`, so
 * an image a tool returned is kept beside the words.
 */
function toolResult(value: Record<string, unknown>, id: string, callId: string | null): ContentBlock {
  const content = value.content ?? value.output ?? value.result;
  const text = stringValue(value, "text") ?? textOfContent(content);
  const data: Record<string, unknown> = isRecord(value.data) ? { ...value.data } : {};
  if (value.is_error === true || value.isError === true) data.isError = true;
  if (Array.isArray(content) && !(content as unknown[]).every(isTextItem)) data.content = content;
  else if (isRecord(content)) data.content = content;
  const name = stringValue(value, "name") ?? stringValue(value, "tool_name");
  return {
    id,
    kind: "tool_result",
    ...(text !== null ? { text } : {}),
    ...(name ? { name } : {}),
    ...(callId ? { callId } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

/**
 * Model reasoning. Anthropic keeps the words under `thinking`, not `text`, so
 * 19,166 of 20,209 thinking blocks on dev were stored empty. The signature is
 * kept so a converted transcript can be handed back to the API, and a
 * redacted block keeps its opaque payload for the same reason.
 */
function thinking(value: Record<string, unknown>, id: string, type: string): ContentBlock {
  const text = stringValue(value, "thinking") ?? stringValue(value, "text");
  const data: Record<string, unknown> = isRecord(value.data) ? { ...value.data } : {};
  const signature = stringValue(value, "signature");
  if (signature) data.signature = signature;
  if (type === "redacted_thinking") {
    data.redacted = true;
    if (typeof value.data === "string") data.data = value.data;
  }
  return {
    id,
    kind: "thinking",
    ...(text !== null ? { text } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

/** A tool call's arguments: an object, or the raw string a custom tool takes. */
function callInput(value: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(value.data)) return value.data;
  if (isRecord(value.input)) return value.input;
  if (typeof value.input === "string") return { input: value.input };
  if (typeof value.arguments === "string") return { arguments: value.arguments };
  return null;
}

export function parseBlock(value: unknown, fallbackId: string): ContentBlock | null {
  if (typeof value === "string") return { id: fallbackId, kind: "text", text: value };
  if (!isRecord(value)) return null;
  // A canonical block names its `kind`. A native one names its `type`, and its
  // fields are the vendor's, so it is read field by field below.
  const canonicalKind = stringValue(value, "kind");
  const kindValue = canonicalKind ?? stringValue(value, "type") ?? "text";
  const aliased = aliasFor(kindValue);
  const kind = kinds.has(aliased as ContentBlockKind) ? aliased as ContentBlockKind : "text";
  // On a tool call, `id` is the id of the call, not of the block: Anthropic
  // writes {type:"tool_use", id:"toolu_..."} and that value belongs in callId.
  // Taking it as the block id put "toolu_..." and "fixture-call-18" where a
  // UUID belongs. A block that names its call separately is stating its own id.
  const namesItsCall = typeof value.callId === "string" || typeof value.tool_use_id === "string";
  const ownId = aliased === "tool_call" && !namesItsCall ? null : stringValue(value, "id");
  // And only if it is one. Block ids are a uuid column, so a source that
  // numbers its blocks any other way had its whole session refused by the
  // database after parsing perfectly. The minted fallback is derived from the
  // session and the block's position, so it is stable across re-captures.
  const id = ownId !== null && isUuid(ownId) ? ownId : fallbackId;
  const callId = stringValue(value, "callId") ?? stringValue(value, "tool_use_id") ?? stringValue(value, "call_id") ?? stringValue(value, "tool_call_id")
    ?? (aliased === "tool_call" ? stringValue(value, "id") : null);

  if (canonicalKind === null) {
    if (kind === "tool_result") return toolResult(value, id, callId);
    if (kind === "thinking") return thinking(value, id, kindValue);
    if (kind === "attachment") return mediaBlock(value, id);
  }
  const data = kind === "tool_call" ? callInput(value) : isRecord(value.data) ? value.data : isRecord(value.input) ? value.input : null;
  const citations = canonicalKind === null && Array.isArray(value.citations) && value.citations.length > 0 ? value.citations : null;
  const block: ContentBlock = {
    id,
    kind,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(callId ? { callId } : {}),
    ...(typeof value.language === "string" ? { language: value.language } : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(typeof value.artifactRef === "string" ? { artifactRef: value.artifactRef } : {}),
    ...(data ? { data } : citations ? { data: { citations } } : {}),
  };
  if (!kinds.has(aliased as ContentBlockKind)) block.ext = { nativeKind: kindValue, native: value };
  return block;
}
