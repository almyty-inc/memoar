export interface Command {
  id: string;
  group: string;
  /** The label, given what was typed. "Search transcripts for …" needs it. */
  label: (query: string) => string;
  /** Extra words that should find this command. */
  keywords?: string;
  detail?: string;
  hint?: string;
  /** Highlight the typed letters in the label. */
  matchLabel?: boolean;
  /** Shown only once something is typed. */
  needsQuery?: boolean;
  /** Always listed, whatever is typed, at the end. */
  always?: boolean;
  run: (query: string) => void;
}

/**
 * How well a query matches a piece of text, or null for no match.
 *
 * A subsequence match, scored up for letters at word starts and for letters
 * that run together, so "tlc" finds "timeline cursor" and "cursor" ranks a
 * title containing the word above one that merely contains the letters.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLocaleLowerCase().replace(/\s+/gu, '');
  if (!needle) return 0;
  const haystack = text.toLocaleLowerCase();
  const direct = haystack.indexOf(query.toLocaleLowerCase().trim());
  if (direct >= 0) return 1000 - direct;
  let score = 0;
  let position = -1;
  let run = 0;
  for (const letter of needle) {
    const found = haystack.indexOf(letter, position + 1);
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s/_\-.:]/u.test(haystack[found - 1] ?? '');
    run = found === position + 1 ? run + 1 : 0;
    score += 1 + (wordStart ? 8 : 0) + run * 3 - Math.min(found - position - 1, 10) * 0.2;
    position = found;
  }
  // Letters scattered across unrelated words are not a match anyone meant.
  return score / needle.length >= 2.5 ? score : null;
}

/** The commands that match, best first, groups kept together in order of their best member. */
export function rank(commands: Command[], query: string, limit = 60): Command[] {
  const typed = query.trim();
  const scored = commands.flatMap((command) => {
    if (command.always) return typed ? [{ command, score: -1 }] : [];
    if (command.needsQuery && !typed) return [];
    if (!typed) return [{ command, score: 0 }];
    const score = fuzzyScore(typed, `${command.label('')} ${command.keywords ?? ''}`);
    return score === null ? [] : [{ command, score }];
  });
  const groupBest = new Map<string, number>();
  for (const { command, score } of scored) groupBest.set(command.group, Math.max(groupBest.get(command.group) ?? -Infinity, score));
  const order = [...groupBest.entries()].sort((left, right) => (typed ? right[1] - left[1] : 0));
  const groupIndex = new Map(order.map(([group], index) => [group, index]));
  return scored
    .sort((left, right) => (groupIndex.get(left.command.group)! - groupIndex.get(right.command.group)!) || (right.score - left.score))
    .slice(0, limit)
    .map(({ command }) => command);
}
