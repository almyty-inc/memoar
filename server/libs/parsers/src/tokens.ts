import type { Session, TokenTotals, Turn } from "../../canonical/src/generated.js";
import { isRecord } from "./common.js";

/*
  How memoar counts tokens, the same way for every source.

  `input` is the prompt tokens the provider processed fresh. Tokens it served
  from a prompt cache are `cacheRead`, and tokens it wrote to one are
  `cacheWrite`. The three never overlap, so `input + cacheRead + cacheWrite` is
  the whole prompt in every source. `output` includes any reasoning tokens.

  This is how Anthropic reports usage, and it is what the web app already shows
  as "in", "out" and "cache read" side by side. A source that folds cached
  tokens into its input count, as OpenAI does and so Codex does, has them taken
  out here. Counting them twice would make a long cached session look as though
  it had sent its whole context fresh on every request.

  The canonical TokenTotals already has `cacheRead` and `cacheWrite`, so none of
  this needs a contract change. They are left out when they are zero.
*/

/** What a turn gets when its source records no usage at all. */
export const NO_TOKENS: Readonly<TokenTotals> = Object.freeze({ input: 0, output: 0 });

/** A count as the contract stores it: a non-negative integer, zero for anything else. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A TokenTotals from four counts, leaving out cache fields that are zero. */
export function tokenTotals(input: unknown, output: unknown, cacheRead: unknown = 0, cacheWrite: unknown = 0): TokenTotals {
  const read = count(cacheRead);
  const write = count(cacheWrite);
  return {
    input: count(input),
    output: count(output),
    ...(read > 0 ? { cacheRead: read } : {}),
    ...(write > 0 ? { cacheWrite: write } : {}),
  };
}

export function addTokens(left: TokenTotals, right: TokenTotals): TokenTotals {
  return tokenTotals(
    left.input + right.input,
    left.output + right.output,
    (left.cacheRead ?? 0) + (right.cacheRead ?? 0),
    (left.cacheWrite ?? 0) + (right.cacheWrite ?? 0),
  );
}

export function isZeroTokens(tokens: TokenTotals): boolean {
  return tokens.input === 0 && tokens.output === 0 && !tokens.cacheRead && !tokens.cacheWrite;
}

/** The sum over every turn that carries a count. */
export function sumTokens(turns: readonly Turn[]): TokenTotals {
  return turns.reduce<TokenTotals>((total, turn) => (turn.tokens ? addTokens(total, turn.tokens) : total), { input: 0, output: 0 });
}

/**
 * A session whose `tokenTotals` is the sum over its turns.
 *
 * The seed carries zeros and no parser used to replace them, so every archived
 * session said it had cost nothing. A session whose turns carry no count at all
 * keeps whatever total it already had, so a source that records usage only for
 * the whole session is not reset to zero.
 */
export function withTokenTotals(session: Session): Session {
  const sum = sumTokens(session.turns);
  return isZeroTokens(sum) ? session : { ...session, tokenTotals: sum };
}

/**
 * Anthropic's `usage` object, which Claude Code writes on every assistant line
 * and Zed keeps per request: `input_tokens` already excludes the cache.
 */
export function anthropicUsage(usage: unknown): TokenTotals | null {
  if (!isRecord(usage)) return null;
  return tokenTotals(usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens);
}

/**
 * OpenAI's usage as Codex writes it in a `token_count` event. `input_tokens`
 * includes `cached_input_tokens`, checked on 4,345 events: the cached count was
 * never larger, and `total_tokens` was `input_tokens + output_tokens`.
 */
export function openAiUsage(usage: unknown): TokenTotals | null {
  if (!isRecord(usage)) return null;
  const cached = count(usage.cached_input_tokens);
  return tokenTotals(Math.max(0, count(usage.input_tokens) - cached), usage.output_tokens, cached, usage.cache_write_input_tokens);
}
