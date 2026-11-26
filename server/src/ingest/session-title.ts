// A title a person can recognise, for sessions whose source names none.
//
// The seed titles every session "<source> imported session" until a parser
// finds a real one, and most formats never write one. On dev that left 964 of
// 980 sessions under three identical names, so the list could not be read.
// The first thing the person asked is what they remember the session by.

import type { Turn } from "../../libs/canonical/src/generated.js";

const MAX_LENGTH = 80;

/** Whether a title is the seed's placeholder rather than one the source gave. */
export function isPlaceholderTitle(title: string | undefined, source: string): boolean {
  return !title || !title.trim() || title === `${source} imported session`;
}

/**
 * The first line of the first user message that is something a person typed.
 *
 * Harness wrappers are skipped: Claude Code sends slash commands, hook output
 * and reminders as user turns wrapped in tags such as `<command-name>`, and a
 * title made of those says nothing about the session.
 */
export function titleFromTurns(turns: readonly Turn[]): string | undefined {
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    for (const block of turn.blocks) {
      if (block.kind !== "text" || !block.text) continue;
      const line = firstMeaningfulLine(block.text);
      if (line) return shorten(line);
    }
  }
  return undefined;
}

/*
  Some agents wrap what the person typed in a tag of their own: Antigravity
  sends every prompt as `<USER_REQUEST>…</USER_REQUEST>`. That is the prompt,
  so the wrapper comes off. Every other leading tag marks text the harness
  injected, such as Claude Code's `<command-name>` or `<local-command-caveat>`,
  and Codex sends the repository's AGENTS.md as the first user message.
*/
const PROMPT_WRAPPER = /^<(user_request|user_query)>\s*([\s\S]*?)\s*(<\/\1>)?\s*$/i;
const INJECTED_PREFIXES = ["# AGENTS.md instructions for", "# CLAUDE.md"];

function unwrap(text: string): string {
  return text.match(PROMPT_WRAPPER)?.[2] ?? text;
}

function firstMeaningfulLine(text: string): string | undefined {
  const trimmed = unwrap(text.trim()).trim();
  if (!trimmed || trimmed.startsWith("<")) return undefined;
  if (INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return undefined;
  const line = trimmed.split("\n").map((part) => part.replace(/\s+/g, " ").trim()).find((part) => part.length > 0);
  return line && /[\p{L}\p{N}]/u.test(line) ? line : undefined;
}

function shorten(line: string): string {
  if (line.length <= MAX_LENGTH) return line;
  const cut = line.slice(0, MAX_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
