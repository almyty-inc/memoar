import type { ContentBlock } from "../../canonical/src/generated.js";
import { isRecord, stringValue } from "./common.js";

/** `data:image/png;base64,…` names its own media type. */
function dataUrlType(url: string): string | null {
  const match = /^data:([^;,]+)[;,]/u.exec(url);
  return match ? match[1]! : null;
}

/**
 * An image, a document or any other file a message carried.
 *
 * These were stored as an attachment with nothing on it: 374 rows on dev, not
 * one with a media type, a reference or the bytes, so the archive knew a
 * picture had been pasted and nothing else about it. The media type goes in
 * `mimeType`. Bytes that arrive inline stay in `data.source`, because the
 * transcript is the only place they exist. A file named by URL or by a
 * provider file id is referenced through `artifactRef` instead.
 *
 * Shapes read:
 *   - Anthropic `{type:"image"|"document", source:{type:"base64"|"url"|"text"|"file", media_type, data|url|file_id}, title?, context?}`
 *   - OpenAI `{type:"input_image", image_url, detail?}`, where image_url is a URL or a data URL
 *   - anything already canonical-shaped, `{mimeType, artifactRef, data}`
 */
export function mediaBlock(value: Record<string, unknown>, id: string): ContentBlock {
  const source = isRecord(value.source) ? value.source : null;
  const imageUrl = stringValue(value, "image_url") ?? (isRecord(value.image_url) ? stringValue(value.image_url, "url") : null);
  const mimeType = (source && (stringValue(source, "media_type") ?? stringValue(source, "mediaType")))
    ?? stringValue(value, "mimeType") ?? stringValue(value, "media_type") ?? stringValue(value, "mime")
    ?? (imageUrl ? dataUrlType(imageUrl) : null);
  const reference = stringValue(value, "artifactRef")
    ?? (source ? stringValue(source, "url") ?? stringValue(source, "file_id") : null)
    ?? (imageUrl && !imageUrl.startsWith("data:") ? imageUrl : null)
    ?? stringValue(value, "url") ?? stringValue(value, "file_id");
  // A document whose source is plain text is prose a reader can search.
  const text = stringValue(value, "text")
    ?? (source && stringValue(source, "type") === "text" ? stringValue(source, "data") : null);
  const data: Record<string, unknown> = isRecord(value.data) ? { ...value.data } : {};
  if (source && !(stringValue(source, "type") === "text")) data.source = source;
  if (imageUrl?.startsWith("data:")) data.imageUrl = imageUrl;
  for (const key of ["context", "detail", "citations", "filename"] as const) {
    if (value[key] !== undefined) data[key] = value[key];
  }
  const name = stringValue(value, "title") ?? stringValue(value, "name") ?? stringValue(value, "filename");
  return {
    id,
    kind: "attachment",
    ...(text !== null ? { text } : {}),
    ...(name ? { name } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(reference ? { artifactRef: reference } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}
