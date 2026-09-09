/**
 * The check in front of the endpoints meant for whoever runs this service
 * rather than for a person with an archive.
 *
 * Metrics and the error list are both operator surfaces: neither is scoped to a
 * tenant, both describe the deployment, and both are reachable by anyone who
 * can reach the service. They share one rule so they cannot drift into two.
 *
 * Absent a token the endpoint does not exist. That is deliberately not 403: an
 * endpoint that answers differently when it is unconfigured tells a stranger it
 * is there and waiting for a secret. And there is no NODE_ENV branch, because
 * security must never be decided by the absence of an environment variable.
 */

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { RequestLike } from "./auth/types.js";

/** Constant-time, so the token cannot be guessed a byte at a time. */
function matches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Throws unless this request carries the operator token. */
export function requireOperatorToken(request: RequestLike): void {
  const expected = process.env.MEMOAR_METRICS_TOKEN?.trim();
  if (!expected) throw new NotFoundException();

  const header = request.headers["authorization"];
  const single = Array.isArray(header) ? header[0] : header;
  const supplied = single?.replace(/^Bearer /u, "");
  if (!supplied || !matches(supplied, expected)) throw new ForbiddenException("Invalid operator credentials");
}
