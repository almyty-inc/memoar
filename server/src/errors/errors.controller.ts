/**
 * What has been failing, grouped.
 *
 * The question this answers is the one neither the log nor the metrics could:
 * "which exception is this, and how often has it happened?" Metrics count
 * failures by class, which tells you something is wrong but not what; the log
 * has every detail and no grouping, so finding out meant grepping a container.
 *
 * Behind the operator token, and never carrying an error's raw message — only
 * the normalised shape, because messages quote their input and their input is
 * somebody's transcript.
 */

import { Controller, Get, Query, Req } from "@nestjs/common";
import { Public } from "../auth.js";
import type { RequestLike } from "../auth/types.js";
import { requireOperatorToken } from "../operator-token.js";
import { errorAggregator, type ErrorGroup } from "./error-aggregator.js";

export interface ErrorReport {
  groups: ErrorGroup[];
  /** Distinct failures currently tracked. */
  distinct: number;
  /** Occurrences not tracked because the cap was reached. */
  dropped: number;
}

@Controller("errors")
export class ErrorsController {
  @Public()
  @Get()
  report(@Req() request: RequestLike, @Query("limit") limit?: string): ErrorReport {
    requireOperatorToken(request);
    const requested = Number.parseInt(limit ?? "", 10);
    return errorAggregator.snapshot(Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 200) : 50);
  }
}
