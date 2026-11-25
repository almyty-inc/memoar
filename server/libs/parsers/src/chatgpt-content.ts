import type { ContentBlock } from "../../canonical/src/generated.js";
import { isRecord, stringValue } from "./common.js";

/** Text kept as a string `part`, or as an object part carrying `text`. */
function partTexts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return (parts as unknown[])
    .map((part) => (typeof part === "string" ? part : isRecord(part) ? stringValue(part, "text") : null))
    .filter((text): text is string => text !== null && text.length > 0);
}

/** `image_asset_pointer` and other file parts of a multimodal message. */
function assetBlocks(parts: unknown, mint: () => string): ContentBlock[] {
  if (!Array.isArray(parts)) return [];
  return (parts as unknown[]).flatMap((part): ContentBlock[] => {
    if (!isRecord(part) || typeof part.text === "string") return [];
    const pointer = stringValue(part, "asset_pointer");
    const mimeType = stringValue(part, "mime_type") ?? (stringValue(part, "content_type") === "image_asset_pointer" ? "image/*" : null);
    return [{ id: mint(), kind: "attachment", ...(pointer ? { artifactRef: pointer } : {}), ...(mimeType ? { mimeType } : {}), data: part }];
  });
}

/** Every string a content object holds, for a content type nobody mapped. */
function allStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) allStrings(item, into);
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) if (key !== "content_type") allStrings(item, into);
  return into;
}

/**
 * The blocks of a message that is not a tool call.
 *
 * Only `parts` were read, and only as text. That dropped everything a ChatGPT
 * export keeps elsewhere: the output of code the model ran
 * (`execution_output`, in `text`), its reasoning (`thoughts`, a list of
 * `{summary, content}`), the reasoning recap (`content`), quoted and browsed
 * pages, system errors, the custom instructions a conversation ran under, and
 * every image in a multimodal message. A content type added since this was
 * written keeps all of its strings.
 */
export function contentBlocks(contentType: string, content: Record<string, unknown>, mint: () => string): ContentBlock[] {
  const text = stringValue(content, "text");
  switch (contentType) {
    case "text":
      return partTexts(content.parts).map((part) => ({ id: mint(), kind: "text", text: part }));
    case "multimodal_text":
      return [
        ...partTexts(content.parts).map((part): ContentBlock => ({ id: mint(), kind: "text", text: part })),
        ...assetBlocks(content.parts, mint),
      ];
    case "code": {
      const code = text ?? partTexts(content.parts).join("");
      const language = stringValue(content, "language");
      return code ? [{ id: mint(), kind: "text", text: code, ...(language && language !== "unknown" ? { language } : {}) }] : [];
    }
    case "execution_output":
      return text ? [{ id: mint(), kind: "tool_result", text }] : [];
    case "thoughts": {
      if (!Array.isArray(content.thoughts)) return partTexts(content.parts).map((part) => ({ id: mint(), kind: "thinking", text: part }));
      return (content.thoughts as unknown[]).flatMap((thought): ContentBlock[] => {
        if (!isRecord(thought)) return [];
        const words = [stringValue(thought, "summary"), stringValue(thought, "content")].filter((value): value is string => !!value);
        return words.length > 0 ? [{ id: mint(), kind: "thinking", text: words.join("\n\n") }] : [];
      });
    }
    case "reasoning_recap": {
      const recap = stringValue(content, "content") ?? partTexts(content.parts).join("\n");
      return recap ? [{ id: mint(), kind: "thinking", text: recap }] : [];
    }
    case "tether_quote": {
      const title = stringValue(content, "title");
      const url = stringValue(content, "url");
      return text ? [{ id: mint(), kind: "text", text, ...(title ? { name: title } : {}), ...(url ? { artifactRef: url } : {}) }] : [];
    }
    case "tether_browsing_display": {
      const result = stringValue(content, "result") ?? stringValue(content, "summary");
      return result ? [{ id: mint(), kind: "tool_result", text: result }] : [];
    }
    case "system_error": {
      const name = stringValue(content, "name");
      return text ? [{ id: mint(), kind: "error", text, ...(name ? { name } : {}) }] : [];
    }
    case "user_editable_context": {
      const words = [stringValue(content, "user_profile"), stringValue(content, "user_instructions")].filter((value): value is string => !!value);
      return words.length > 0 ? [{ id: mint(), kind: "system", name: contentType, text: words.join("\n\n") }] : [];
    }
    default: {
      const words = allStrings(content).filter((value) => value.length > 0);
      return words.length > 0 ? [{ id: mint(), kind: "text", text: words.join("\n"), ext: { nativeKind: contentType } }] : [];
    }
  }
}
