/**
 * The scrape endpoint.
 *
 * Metrics are not public. They say how much is being archived, how many
 * accounts fail to sign in, and how big this deployment is — and a scrape
 * endpoint is reachable by anyone who can reach the service. It is guarded by
 * the operator token, along with the error report, which is the other endpoint
 * that describes the deployment rather than anybody's archive.
 */

import { Controller, Get, Header, Req } from "@nestjs/common";
import type { RequestLike } from "../auth/types.js";
import { Public } from "../auth.js";
import { requireOperatorToken } from "../operator-token.js";
import { METRICS_CONTENT_TYPE } from "./metrics.registry.js";
import { MetricsService } from "./metrics.service.js";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @Header("content-type", METRICS_CONTENT_TYPE)
  async scrape(@Req() request: RequestLike): Promise<string> {
    requireOperatorToken(request);
    return this.metrics.render();
  }
}
