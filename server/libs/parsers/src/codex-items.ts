import type { ContentBlock } from "../../canonical/src/generated.js";
import { textOfContent } from "./blocks.js";
import { isRecord, stringValue } from "./common.js";
import { mediaBlock } from "./media.js";

/**
 * Response items that list what the model could call rather than anything it
 * said or did. Every rollout carries the full tool catalogue, often more than
 * once, and it is the harness's configuration.
 */
export const CODEX_BOOKKEEPING_ITEMS = new Set(["additional_tools"]);

/** Decodes tool arguments, keeping them verbatim when they are not JSON. */
export function toolData(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = stringValue(payload, "arguments") ?? stringValue(payload, "input");
  if (raw === null) return isRecord(payload.input) ? payload.input : isRecord(payload.action) ? payload.action : {};
  try {
    const decoded: unknown = JSON.parse(raw);
    if (isRecord(decoded)) return decoded;
  } catch {
    // Not JSON; the text is still what the model asked for.
  }
  return { arguments: raw };
}

/**
 * A message's content: its text items joined into one block, as before, and
 * each image beside it. `input_image` items were dropped, so a screenshot a
 * person pasted into Codex left no trace.
 */
export function messageBlocks(content: unknown, mint: () => string): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const items = content as unknown[];
  const text = items
    .map((entry) => (isRecord(entry) ? stringValue(entry, "text") ?? "" : typeof entry === "string" ? entry : ""))
    .filter((value) => value.length > 0)
    .join("");
  const blocks: ContentBlock[] = text.length > 0 ? [{ id: mint(), kind: "text", text }] : [];
  for (const entry of items) {
    if (isRecord(entry) && stringValue(entry, "type") === "input_image") blocks.push(mediaBlock(entry, mint()));
  }
  return blocks;
}

/**
 * Reasoning. The summary is what a reader can use. `encrypted_content` is
 * opaque by design, and was discarded, so a converted rollout could never be
 * resumed with its reasoning. It is kept in `data` now, unread.
 */
export function reasoningBlock(payload: Record<string, unknown>, mint: () => string): ContentBlock | null {
  const text = textOfContent(payload.summary) ?? textOfContent(payload.content);
  const encrypted = stringValue(payload, "encrypted_content");
  if (!text && !encrypted) return null;
  return {
    id: mint(),
    kind: "thinking",
    ...(text ? { text } : {}),
    ...(encrypted ? { data: { encrypted } } : {}),
  };
}

/**
 * A tool's output.
 *
 * Current rollouts write `output` as an array of `input_text` and
 * `input_image` items, 1,562 of 1,867 outputs on one machine. It was stored as
 * that array's JSON, so the archive searched `[{"type":"input_text",…` and the
 * images were base64 inside a string. The text is the text now, and an output
 * that holds an image keeps the array in `data.content`. Older rollouts wrote
 * `{content, success}`, whose failure flag becomes `data.isError`.
 */
export function outputBlock(payload: Record<string, unknown>, mint: () => string): ContentBlock {
  const output = payload.output;
  const data: Record<string, unknown> = {};
  let text: string | null;
  if (typeof output === "string") text = output;
  else if (Array.isArray(output)) {
    text = textOfContent(output);
    if ((output as unknown[]).some((item) => isRecord(item) && stringValue(item, "type") !== "input_text")) data.content = output;
  } else if (isRecord(output)) {
    text = stringValue(output, "content") ?? textOfContent(output.content);
    if (output.success === false) data.isError = true;
    if (text === null) data.content = output;
  } else text = null;
  const name = stringValue(payload, "name");
  return {
    id: mint(),
    kind: "tool_result",
    callId: stringValue(payload, "call_id") ?? mint(),
    ...(name ? { name } : {}),
    ...(text !== null ? { text } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

/** Tool calls Codex runs itself, with an `action` instead of arguments. */
export const BUILT_IN_CALLS: Readonly<Record<string, string>> = {
  local_shell_call: "local_shell",
  web_search_call: "web_search",
  image_generation_call: "image_generation",
};
