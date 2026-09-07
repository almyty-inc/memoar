/**
 * Counts and times every request.
 *
 * Deliberately the same shape as the request log next door: method, route
 * pattern, status. The log answers "what happened to this request", the metric
 * answers "what is happening to all of them", and they agree because they read
 * the same fields.
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable, tap } from "rxjs";
import { httpDuration, httpRequests } from "./metrics.registry.js";

/**
 * The route pattern, never the concrete path.
 *
 * `/v1/sessions/:id` is one time series. The path it was reached by is one
 * series per session, which is an unbounded label set and the usual way a
 * metrics store is brought down by the service it monitors.
 */
function routeOf(request: Request): string {
  const pattern = (request as { route?: { path?: string } }).route?.path;
  if (pattern) return pattern;
  // No matched route means no handler: one series for every 404, whatever was
  // asked for, rather than one per made-up path.
  return "unmatched";
}

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const method = request.method;
    const done = httpDuration.startTimer();

    const record = (status: number): void => {
      const route = routeOf(request);
      done({ method, route });
      httpRequests.inc({ method, route, status: String(status) });
    };

    return next.handle().pipe(
      tap({
        next: () => { record(http.getResponse<Response>().statusCode); },
        // A failed request is the one worth counting, so the error path records
        // it too — and takes the status from the exception, because the
        // response has not been written yet.
        error: (error: unknown) => {
          const status = (error as { status?: number }).status;
          record(typeof status === "number" ? status : 500);
        },
      }),
    );
  }
}
