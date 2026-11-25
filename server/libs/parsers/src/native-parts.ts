import { isRecord, stringValue } from "./common.js";

/** Arguments some stores keep as a JSON string. */
function decodedArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * Crush part types that carry no content: `finish` records why and when the
 * model stopped.
 */
const CRUSH_BOOKKEEPING = new Set(["finish"]);

/**
 * A Crush part, unwrapped into the shape `parseBlock` reads.
 *
 * Crush serialises every part as `{type, data:{…}}`, so the text of a text
 * part is at `data.text`, not `text`. Read as it was, every Crush message kept
 * its words only inside `data` and never in the block's text, and reasoning,
 * tool arguments and tool output were the same. Returns null for bookkeeping.
 */
export function crushPart(part: unknown): unknown {
  // Only the wrapper itself: a part with fields beside `type` and `data` is
  // already flat, and its `data` is its own.
  if (!isRecord(part) || !isRecord(part.data) || Object.keys(part).some((key) => key !== "type" && key !== "data")) return part;
  const type = stringValue(part, "type") ?? "text";
  if (CRUSH_BOOKKEEPING.has(type)) return null;
  const data = part.data;
  switch (type) {
    case "reasoning":
      return { type: "thinking", thinking: data.thinking, signature: data.signature };
    case "tool_call":
      return { type: "tool_use", id: data.id, name: data.name, input: decodedArguments(data.input) };
    case "tool_result":
      return { type: "tool_result", tool_use_id: data.tool_call_id, name: data.name, content: data.content, is_error: data.is_error, ...(data.metadata ? { data: { metadata: data.metadata } } : {}) };
    case "image_url":
      return { type: "image", url: data.url, detail: data.detail };
    case "binary":
      return { type: "document", artifactRef: data.path, media_type: data.mime_type, data: { bytes: data.data } };
    default:
      return { type, ...data };
  }
}

/** Goose message content types that are signals to the UI, not content. */
const GOOSE_BOOKKEEPING = new Set(["toolConfirmationRequest", "frontendToolRequest"]);

/**
 * A goose content item, in the shape `parseBlock` reads.
 *
 * Goose keeps a tool's name and arguments under `toolCall.value` and its
 * output under `toolResult.value`, so a call parsed to a nameless block with no
 * arguments and a result to an empty one. Its reasoning is `thinking` and
 * `redactedThinking`, and an image keeps its bytes in `data`.
 */
export function goosePart(part: unknown): unknown {
  if (!isRecord(part) || typeof part.kind === "string") return part;
  const type = stringValue(part, "type");
  if (type && GOOSE_BOOKKEEPING.has(type)) return null;
  if (type === "toolRequest" && isRecord(part.toolCall)) {
    const call = part.toolCall;
    const value = isRecord(call.value) ? call.value : {};
    // A call goose could not even decode keeps its error in place of arguments.
    const input = decodedArguments(value.arguments) ?? (call.status === "error" ? { error: call.error } : {});
    return { type: "tool_use", id: part.id, name: value.name, input };
  }
  if (type === "toolResponse" && isRecord(part.toolResult)) {
    const result = part.toolResult;
    const value = isRecord(result.value) && Array.isArray(result.value.content) ? result.value.content : result.value;
    const failed = result.status === "error" || (isRecord(result.value) && result.value.isError === true);
    return { type: "tool_result", tool_use_id: part.id, content: value ?? result.error, is_error: failed };
  }
  if (type === "redactedThinking") return { type: "redacted_thinking", data: part.data };
  if (type === "image" && typeof part.data === "string") return { type: "image", mimeType: part.mimeType, data: { bytes: part.data } };
  if (type === "contextLengthExceeded" || type === "summarizationRequested" || type === "systemNotification") {
    return { kind: "system", name: type, text: stringValue(part, "msg") ?? stringValue(part, "text") ?? undefined };
  }
  return part;
}
