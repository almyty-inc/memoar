import { randomUUID } from "node:crypto";
import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { errorAggregator } from "./errors/error-aggregator.js";
import type { Request, Response } from "express";

/**
 * A line of structured log.
 *
 * One JSON object per line, because a person greps these and a machine parses
 * them, and a human-readable line satisfies neither well once there is more
 * than one process writing.
 */
export function logLine(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`);
}

/** The id a caller can quote, taken from the edge when one arrives. */
export function requestId(request: Request): string {
  const existing = request.headers["x-request-id"];
  const supplied = Array.isArray(existing) ? existing[0] : existing;
  // Bounded and sanitised: an id is echoed back in a header and written to the
  // log, so a caller must not be able to inject either.
  if (supplied && /^[\w-]{1,64}$/u.test(supplied)) return supplied;
  return randomUUID();
}

function tenantOf(request: Request): string | undefined {
  return (request as { tenantContext?: { tenantId?: string } }).tenantContext?.tenantId;
}

/** The route pattern, never the concrete path: ids do not belong in log keys. */
function routeOf(request: Request): string {
  return (request as { route?: { path?: string } }).route?.path ?? request.path;
}

/**
 * Logs one line per request, and gives every request an id.
 *
 * There was no request log at all, so "it failed at about two o'clock" was the
 * whole of what an operator had to work with. What is recorded here is the
 * shape of the request — method, route pattern, status, duration, tenant — and
 * never a body, a query string or a header, because those carry session
 * content and credentials.
 */
@Injectable()
export class RequestLogInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const id = requestId(request);
    (request as { requestId?: string }).requestId = id;
    response.setHeader("x-request-id", id);
    const startedAt = process.hrtime.bigint();

    const finish = (status: number, error?: unknown): void => {
      logLine({
        level: status >= 500 ? "error" : "info",
        message: "request",
        requestId: id,
        method: request.method,
        route: routeOf(request),
        status,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
        ...(tenantOf(request) ? { tenantId: tenantOf(request) } : {}),
        ...(error instanceof Error && status >= 500 ? { error: error.message } : {}),
      });
    };

    return next.handle().pipe(tap({
      next: () => finish(response.statusCode),
      error: (error: unknown) => finish(error instanceof HttpException ? error.getStatus() : 500, error),
    }));
  }
}

/**
 * Turns every failure into the problem document the contract describes.
 *
 * Without this, anything unexpected became Nest's default body — a bare
 * "Internal server error" with no code and no request id — so a caller had
 * nothing to quote and an operator had nothing to search for. An unexpected
 * error still says nothing about its cause to the client: the message and stack
 * go to the log, under the id the client was given.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http") throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const id = (request as { requestId?: string }).requestId ?? requestId(request);
    const status = statusFor(exception);

    if (status >= 500) {
      // Grouped as well as logged, and the group's id goes in the line: the log
      // says what happened once, the fingerprint says which of these is one
      // problem happening repeatedly.
      const group = errorAggregator.record(exception, { requestId: id, route: routeOf(request) });
      logLine({
        level: "error",
        message: "unhandled",
        requestId: id,
        method: request.method,
        route: routeOf(request),
        status,
        ...(tenantOf(request) ? { tenantId: tenantOf(request) } : {}),
        ...(group ? { fingerprint: group.id, occurrences: group.count } : {}),
        error: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }

    response.setHeader("x-request-id", id);
    response.status(status).type("application/problem+json").send({
      ...problemBody(exception, status),
      requestId: id,
    });
  }
}

/** Keeps a hand-written problem as it is; gives anything else a safe one. */
function problemBody(exception: unknown, status: number): Record<string, unknown> {
  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    // Handlers that already speak problem+json keep their wording.
    if (typeof body === "object" && body !== null && "type" in body && "title" in body) {
      return body;
    }
    const message = typeof body === "string" ? body : (body as { message?: unknown }).message;
    const detail = Array.isArray(message)
      ? message.map((entry) => String(entry)).join("; ")
      : typeof message === "string" ? message : undefined;
    return {
      type: `https://memoar.dev/problems/${slug(status)}`,
      title: title(status),
      status,
      code: slug(status),
      // A 4xx is the caller's own mistake and saying what it was helps them;
      // a 5xx is ours, and its detail belongs in the log, not the response.
      ...(status < 500 && detail !== undefined ? { detail } : {}),
    };
  }
  return {
    type: "https://memoar.dev/problems/internal-error",
    title: "Internal server error",
    status,
    code: "internal_error",
  };
}

/**
 * The status an exception deserves.
 *
 * body-parser throws a plain Error carrying `status: 413` rather than a Nest
 * HttpException, so an oversized body came back as a 500 "internal error" —
 * logged as unhandled, fingerprinted as a server fault, and telling the client
 * nothing it could act on. A manifest too large to describe is the caller's
 * problem to fix and must say so.
 */
export function statusFor(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  const reported = (exception as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (exception as { statusCode?: unknown } | null)?.statusCode;
  if (typeof reported === "number" && reported >= 400 && reported < 600) return reported;
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function slug(status: number): string {
  return String(HttpStatus[status] ?? "request_failed").toLowerCase();
}

/** "NOT_FOUND" is the enum's name, not a sentence: this is for a person. */
function title(status: number): string {
  const name = String(HttpStatus[status] ?? "Request failed").replaceAll("_", " ").toLowerCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}
