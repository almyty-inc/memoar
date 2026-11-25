import type { ContentBlock } from "../../canonical/src/generated.js";
import { isRecord, stringValue } from "./common.js";

/** Tool arguments Cursor keeps as a JSON string in `rawArgs` or `params`. */
function decoded(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { arguments: value };
  } catch {
    return { arguments: value };
  }
}

/** A tool's result, which Cursor writes as a string or as JSON of its own. */
function resultText(value: unknown): string | null {
  if (typeof value === "string") return value;
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * The blocks one Cursor bubble holds.
 *
 * Read: reasoning in `allThinkingBlocks` and in `thinking` (`{text, signature}`,
 * which newer builds write and which was not read), the reply in `text`, tool
 * results in `toolResults`, the agent's tool call in `toolFormerData`
 * (`{name, rawArgs|params, result, status, toolCallId}`, also not read, so an
 * agent bubble that only ran a tool parsed to nothing), and pasted images,
 * which Cursor keeps on disk and names by path.
 */
export function cursorBubbleBlocks(bubble: Record<string, unknown>, mint: () => string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const thought of Array.isArray(bubble.allThinkingBlocks) ? bubble.allThinkingBlocks : []) {
    const text = typeof thought === "string" ? thought : isRecord(thought) ? stringValue(thought, "text") : null;
    if (text) blocks.push({ id: mint(), kind: "thinking", text });
  }
  if (isRecord(bubble.thinking)) {
    const text = stringValue(bubble.thinking, "text");
    const signature = stringValue(bubble.thinking, "signature");
    if (text || signature) blocks.push({ id: mint(), kind: "thinking", ...(text ? { text } : {}), ...(signature ? { data: { signature } } : {}) });
  }
  const text = stringValue(bubble, "text");
  if (text) blocks.push({ id: mint(), kind: "text", text });
  const tool = isRecord(bubble.toolFormerData) ? bubble.toolFormerData : null;
  if (tool) {
    const callId = stringValue(tool, "toolCallId") ?? mint();
    blocks.push({ id: mint(), kind: "tool_call", name: stringValue(tool, "name") ?? "tool", callId, data: decoded(tool.rawArgs) ?? decoded(tool.params) ?? {} });
    const output = resultText(tool.result);
    const failed = stringValue(tool, "status") === "error";
    if (output !== null || failed) {
      blocks.push({ id: mint(), kind: "tool_result", callId, ...(output !== null ? { text: output } : {}), ...(failed ? { data: { isError: true } } : {}) });
    }
  }
  for (const result of Array.isArray(bubble.toolResults) ? bubble.toolResults : []) {
    if (!isRecord(result)) continue;
    const output = stringValue(result, "result") ?? stringValue(result, "output") ?? stringValue(result, "text");
    blocks.push({
      id: mint(),
      kind: "tool_result",
      ...(stringValue(result, "toolCallId") ? { callId: stringValue(result, "toolCallId")! } : {}),
      ...(output ? { text: output } : {}),
    });
  }
  for (const image of Array.isArray(bubble.images) ? bubble.images : []) {
    if (!isRecord(image)) continue;
    const path = stringValue(image, "path") ?? stringValue(image, "uri");
    blocks.push({ id: mint(), kind: "attachment", ...(path ? { artifactRef: path } : {}), data: image });
  }
  return blocks;
}
