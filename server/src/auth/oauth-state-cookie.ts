/**
 * The cookie that ties a provider sign-in to the browser that began it.
 *
 * `state` on its own proves only that this server minted it, and this server
 * mints one for anybody who asks: `GET /v1/auth/oauth/github` is public. So an
 * attacker could begin a sign-in of their own, stop at the provider's redirect,
 * keep the `code` and the `state`, and then get a victim's browser to load the
 * callback with both. The exchange succeeded, the archive issued a session for
 * the *attacker's* account, and the victim's browser was redirected into it
 * holding that token — after which everything they captured or wrote went into
 * somebody else's archive. The state was signed, unexpired and for the right
 * provider throughout; none of those facts say the browser presenting it is the
 * browser that started the flow.
 *
 * So the state carries a nonce and the browser is given the only copy of it.
 * A callback that cannot produce the matching cookie is not the end of a
 * sign-in this browser began, whatever else is right about it.
 */

/** Named for the flow, and scoped to it: nothing else on the API needs it. */
export const OAUTH_STATE_COOKIE = "memoar_oauth_state";

/** The path the cookie is offered on: the two OAuth routes and nothing else. */
const COOKIE_PATH = "/v1/auth/oauth";

/**
 * SameSite=Lax rather than Strict, deliberately. The browser arrives at the
 * callback by a top-level navigation from the provider's domain, and Strict
 * withholds the cookie on exactly that request — the one request it exists for.
 * Lax sends it on a top-level GET, which is what this is, and still withholds
 * it from the cross-site sub-requests that a forgery would use.
 */
function attributes(maxAgeSeconds: number): string {
  const parts = [`Path=${COOKIE_PATH}`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  // Not in development, where the archive is reached over plain http and a
  // Secure cookie would simply never be stored.
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

/** Set when a sign-in begins; lives as long as the state it is bound to. */
export function oauthStateCookie(nonce: string): string {
  return `${OAUTH_STATE_COOKIE}=${nonce}; ${attributes(600)}`;
}

/**
 * Cleared at the callback, before the code is exchanged, which is what makes a
 * state single use: replaying one lands on a browser that no longer holds the
 * nonce, so the second attempt fails however much life the state had left.
 */
export function clearedOAuthStateCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; ${attributes(0)}`;
}

/** The nonce this browser is holding, or null if it is holding none. */
export function oauthStateNonce(cookieHeader: string | string[] | undefined): string | null {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== OAUTH_STATE_COOKIE) continue;
    return pair.slice(separator + 1).trim() || null;
  }
  return null;
}
