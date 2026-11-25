import type { ContentBlock, Turn } from "../../canonical/src/generated.js";
import { parseBlock, textOfContent } from "./blocks.js";
import { isRecord, stringValue } from "./common.js";

/**
 * Claude Code lines that are part of the conversation without being a
 * `message`.
 *
 * Only lines with both `uuid` and `message` were read, so everything else was
 * dropped whole: the `/compact` boundary and the output of a local command, the
 * "while you were away" summary, a prompt typed while the agent was busy, a
 * file attached with `@`, and the snippet of an edit the person made by hand.
 * Those are kept here as turns of their own.
 *
 * What is still left out is the harness's own bookkeeping, and the list is
 * explicit so that leaving something out is a decision rather than a default:
 * hook stdout, token and date reminders, tool and skill listings, the system
 * prompt snapshot, environment snapshots and permission and mode changes. None
 * of them is something the person or the model said.
 */
export const BOOKKEEPING_ATTACHMENTS = new Set([
  "hook_success", "hook_cancelled", "hook_non_blocking_error", "total_tokens_reminder", "silent_turn_reminder",
  "deferred_tools_record", "deferred_tools_delta", "skill_listing", "mcp_instructions_delta", "agent_listing_delta",
  "prompt_snapshot", "credential_org", "environment", "session_context", "instructions", "date", "date_change",
  "model", "auto_mode", "command_permissions", "thinking_drop", "task_reminder", "task_status", "invoked_skills",
  "compact_file_reference", "goal_status", "diagnostics", "todo_reminder", "plan_mode", "critical_system_reminder",
]);

export interface RecordTurn {
  role: Turn["role"];
  blocks: ContentBlock[];
  ext: Record<string, unknown>;
}

/** The text a `file` attachment holds, which is nested one or two levels down. */
function fileText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!isRecord(content)) return null;
  if (isRecord(content.file)) return stringValue(content.file, "content") ?? null;
  return stringValue(content, "content") ?? stringValue(content, "text");
}

function attachmentTurn(attachment: Record<string, unknown>, mint: () => string): RecordTurn | null {
  const type = stringValue(attachment, "type") ?? "unknown";
  if (BOOKKEEPING_ATTACHMENTS.has(type)) return null;
  const ext = { claudeCode: { recordType: "attachment", attachmentType: type } };
  if (type === "queued_command") {
    const prompt = attachment.prompt;
    const blocks = Array.isArray(prompt)
      ? (prompt as unknown[]).map((item) => parseBlock(item, mint())).filter((block) => block !== null)
      : typeof prompt === "string" && prompt.length > 0 ? [{ id: mint(), kind: "text" as const, text: prompt }] : [];
    return blocks.length === 0 ? null : { role: attachment.isMeta === true ? "system" : "user", blocks, ext };
  }
  if (type === "file" || type === "edited_text_file") {
    const filename = stringValue(attachment, "filename");
    const name = stringValue(attachment, "displayPath") ?? filename;
    const text = type === "file" ? fileText(attachment.content) : stringValue(attachment, "snippet");
    const nested = isRecord(attachment.content) && text === null ? { data: attachment.content } : {};
    return {
      role: "system",
      blocks: [{ id: mint(), kind: "attachment", ...(name ? { name } : {}), ...(filename ? { artifactRef: filename } : {}), ...(text !== null ? { text } : {}), ...nested }],
      ext,
    };
  }
  if (type === "hook_blocking_error") {
    const error = isRecord(attachment.blockingError) ? attachment.blockingError : {};
    const text = stringValue(error, "blockingError") ?? stringValue(attachment, "blockingError");
    const name = stringValue(attachment, "hookName") ?? type;
    return text ? { role: "system", blocks: [{ id: mint(), kind: "error", name, text, data: attachment }], ext } : null;
  }
  // Context a hook added to the conversation, and any attachment type added
  // since this list was written: its text if it has any, and the whole record.
  const text = textOfContent(attachment.content) ?? stringValue(attachment, "text") ?? stringValue(attachment, "prompt");
  return { role: "system", blocks: [{ id: mint(), kind: "system", name: type, ...(text !== null ? { text } : {}), data: attachment }], ext };
}

/**
 * The turn a non-message line becomes, or null for bookkeeping.
 *
 * `system` lines with no content (turn durations, stop-hook summaries) are
 * timing records and are not turns.
 */
export function recordTurn(record: Record<string, unknown>, mint: () => string): RecordTurn | null {
  const type = stringValue(record, "type");
  if (type === "system") {
    const content = stringValue(record, "content");
    if (!content) return null;
    const subtype = stringValue(record, "subtype") ?? "system";
    const data: Record<string, unknown> = {};
    for (const key of ["level", "compactMetadata", "isMeta"] as const) if (record[key] !== undefined) data[key] = record[key];
    return {
      role: "system",
      blocks: [{ id: mint(), kind: "system", name: subtype, text: content, ...(Object.keys(data).length > 0 ? { data } : {}) }],
      ext: { claudeCode: { recordType: "system", subtype } },
    };
  }
  if (type === "attachment" && isRecord(record.attachment)) return attachmentTurn(record.attachment, mint);
  if (type === "summary") {
    const summary = stringValue(record, "summary");
    return summary
      ? { role: "system", blocks: [{ id: mint(), kind: "system", name: "summary", text: summary }], ext: { claudeCode: { recordType: "summary" } } }
      : null;
  }
  return null;
}
