import type { TokenTotals } from "../../canonical/src/generated.js";
import { isRecord, stringValue } from "./common.js";
import { anthropicUsage, NO_TOKENS } from "./tokens.js";

/**
 * The usage of each API message in a Claude Code transcript, counted once.
 *
 * Claude Code writes one line per content block of a response, and every line
 * of one response repeats its `message.id` and its `usage`. On the machine this
 * was checked on, 14,682 of 25,240 responses spanned several lines, and only
 * one of them disagreed with itself, its last line having the larger output
 * count. So the usage of a message is the one on its last line, and it is
 * given to the first turn that message produced, the others getting zero.
 * Summing every line instead would count a thinking block, a reply and a tool
 * call written for one request as three requests.
 *
 * A line with no `message.id` is counted on its own, since nothing ties it to
 * another.
 */
export class ClaudeCodeUsage {
  private readonly byMessage = new Map<string, TokenTotals>();
  private readonly claimed = new Set<string>();

  constructor(records: readonly Record<string, unknown>[]) {
    for (const record of records) {
      const message = isRecord(record.message) ? record.message : null;
      const id = message ? stringValue(message, "id") : null;
      const usage = message ? anthropicUsage(message.usage) : null;
      if (id && usage) this.byMessage.set(id, usage);
    }
  }

  /** The usage for this line's turn: the message's, the first time it is asked for. */
  claim(message: Record<string, unknown>): TokenTotals {
    const id = stringValue(message, "id");
    if (!id) return anthropicUsage(message.usage) ?? NO_TOKENS;
    if (this.claimed.has(id)) return NO_TOKENS;
    this.claimed.add(id);
    return this.byMessage.get(id) ?? NO_TOKENS;
  }
}

/**
 * The working directory and branch a transcript records.
 *
 * Read from the first message line, as before, and otherwise from the first
 * line of any kind that names one. A transcript whose first message line
 * carries no `cwd` used to give its own file path as the workspace.
 */
export function claudeCodeWorkspace(first: Record<string, unknown>, records: readonly Record<string, unknown>[]): { cwd: string | null; branch: string | null } {
  const firstOf = (key: string): string | null => stringValue(first, key) || records.map((record) => stringValue(record, key)).find((value) => !!value) || null;
  return { cwd: firstOf("cwd"), branch: firstOf("gitBranch") };
}
