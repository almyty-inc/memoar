import { BadRequestException, ForbiddenException } from "@nestjs/common";

/**
 * Every scope this server understands.
 *
 * An API key's scopes were bounded only by count and string length, so any
 * signed-in user could mint a key asking for whatever they liked — including
 * `*`, which the guard short-circuits on before it compares anything. A key
 * with `*` on it passes every @RequireScopes in the codebase, so the scope
 * system was opt-out by the caller.
 *
 * `*` is deliberately absent: it is a wildcard the guard honours, never a
 * grant anybody may ask for.
 */
export const KNOWN_SCOPES: readonly string[] = [
  "archive:read",
  "archive:write",
  "sharing:write",
  "keys:write",
  "machines:write",
  "ingest:write",
  "machine:heartbeat",
  "materialize:read",
  "mcp:use",
];

/**
 * Checks a requested grant against the vocabulary and against the caller.
 *
 * Two separate refusals because they are two different mistakes: a scope that
 * does not exist is a malformed request, and a scope the caller has not got is
 * an attempt to hold more than they were given. Delegation can only ever narrow
 * — a key is issued by somebody, and it must not outrank them.
 *
 * A caller holding the guard's wildcard (the development identity) may grant
 * anything in the vocabulary, but still nothing outside it.
 */
export function assertGrantableScopes(requested: readonly string[], held: readonly string[]): void {
  const unknown = requested.filter((scope) => !KNOWN_SCOPES.includes(scope));
  if (unknown.length > 0) {
    throw new BadRequestException({
      type: "https://memoar.dev/problems/unknown-scope",
      title: "Unknown scope",
      status: 400,
      code: "unknown_scope",
      detail: `Not a scope this server grants: ${unknown.join(", ")}. Known scopes: ${KNOWN_SCOPES.join(", ")}.`,
    });
  }
  if (held.includes("*")) return;
  const beyond = requested.filter((scope) => !held.includes(scope));
  if (beyond.length > 0) {
    throw new ForbiddenException({
      type: "https://memoar.dev/problems/scope-escalation",
      title: "Scope exceeds the caller's own",
      status: 403,
      code: "scope_escalation",
      detail: `A key cannot hold what its creator does not: ${beyond.join(", ")}.`,
    });
  }
}
