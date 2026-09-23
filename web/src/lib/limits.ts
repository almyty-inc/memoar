/**
 * Numbers the interface quotes to the reader.
 *
 * The context budget was three separate literals: the copy under the results
 * promised 4,000 tokens, the search's pack request sent 4000, and the session
 * pack control defaulted to 4000. Three places to change, so a change in one
 * left the sentence describing a budget the product no longer used.
 */

/**
 * The shortest password the archive accepts, for a new account and for a
 * changed password alike. Stated, not discovered. The server's rule is in
 * server/src/auth/password-rule.ts and the contract says the same.
 */
export const MINIMUM_PASSWORD = 10;

/** The context budget a pack is built to unless the reader chooses another. */
export const DEFAULT_PACK_TOKEN_BUDGET = 4000;

/** The same number, written the way a person reads it. */
export function formatTokenBudget(tokens: number): string {
  return tokens.toLocaleString('en');
}
