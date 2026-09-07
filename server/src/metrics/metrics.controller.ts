/**
 * The scrape endpoint.
 *
 * Metrics are not public. They say how much is being archived, how many
 * accounts fail to sign in, and how big this deployment is — and a scrape
 * endpoint is reachable by anyone who can reach the service. So it exists only
 * when `MEMOAR_METRICS_TOKEN` is set, and always requires that token: there is
 * no NODE_ENV branch here, because the last thing that decided its own security
 * from the absence of an environment variable was the authentication guard, and
 * it was wrong for exactly this reason.
 */

import { Controller, ForbiddenException, Get, Header, NotFoundException, Req } from "@nestjs/common";
import type { RequestLike } from "../auth/types.js";
import { timingSafeEqual } from "node:crypto";
import { Public } from "../auth.js";
import { METRICS_CONTENT_TYPE } from "./metrics.registry.js";
import { MetricsService } from "./metrics.service.js";

/** Constant-time comparison, so the token cannot be guessed a byte at a time. */
function matches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @Header("content-type", METRICS_CONTENT_TYPE)
  async scrape(@Req() request: RequestLike): Promise<string> {
    const expected = process.env.MEMOAR_METRICS_TOKEN?.trim();
    // Not "403 without a token": an endpoint that answers differently when it
    // is unconfigured tells a stranger it is there and waiting for a secret.
    if (!expected) throw new NotFoundException();

    const header = request.headers["authorization"];
    const single = Array.isArray(header) ? header[0] : header;
    const supplied = single?.replace(/^Bearer /u, "");
    if (!supplied || !matches(supplied, expected)) throw new ForbiddenException("Invalid metrics credentials");

    return this.metrics.render();
  }
}
