// A title a person can recognise, for sessions whose source names none.
//
// The seed titles every session "<source> imported session" until a parser
// finds a real one, and most formats never write one. On dev that left 964 of
// 980 sessions under three identical names, so the list could not be read.
// The first thing the person asked is what they remember the session by.

import type { Turn } from "../../libs/canonical/src/generated.js";

const MAX_LENGTH = 80;

/**
 * Whether a title says nothing a person would recognise: the seed's
 * placeholder, or text the harness injected. An earlier title pass named 85
 * Codex sessions "# AGENTS.md instructions", so a stored title is judged by the
 * same rule as the turns it came from.
 */
export function isPlaceholderTitle(title: string | undefined, source: string): boolean {
  if (!title || !title.trim() || title === `${source} imported session`) return true;
  return firstMeaningfulLine(title) === undefined;
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
  injected, such as Claude Code's `<command-name>` or `<local-command-caveat>`.

  Codex injects in Markdown instead. It sends the repository's AGENTS.md as
  the first user message, and a summary of the history after compaction. Its
  IDE extension puts the open files first and the prompt last, under
  `## My request for Codex:`, so the prompt is taken from there.
*/
const PROMPT_WRAPPER = /^<(user_request|user_query)>\s*([\s\S]*?)\s*(<\/\1>)?\s*$/i;
const CODEX_REQUEST = /^## My request for Codex:\s*$/m;
const INJECTED_PREFIXES = [
  "# AGENTS.md instructions",
  "# CLAUDE.md",
  "# Context from my IDE setup",
  "# Files mentioned by the user",
  "## Referenced ChatGPT conversation",
  "The following is the Codex agent history",
];

function unwrap(text: string): string {
  const request = CODEX_REQUEST.exec(text);
  if (request) return text.slice(request.index + request[0].length);
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
