import { CallHandler, CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor, SetMetadata } from "@nestjs/common";
import { Observable, catchError, throwError } from "rxjs";
import { Reflector } from "@nestjs/core";

import { rateLimitRejections } from "./metrics/metrics.registry.js";
import { Redis } from "ioredis";
import type { Request, Response } from "express";

export interface RateLimit {
  /** Requests allowed inside the window. */
  readonly limit: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
}

export const RATE_LIMIT_KEY = "memoar:rate-limit";

/** Names the budget a route draws from. */
export type BudgetName = "default" | "credential";

/** Puts a route on a named budget rather than the default one. */
export const Throttle = (budget: BudgetName) => SetMetadata(RATE_LIMIT_KEY, budget);

export const CREDENTIAL_LIMIT: BudgetName = "credential";

function budgetFromEnv(name: string, fallback: RateLimit): RateLimit {
  const raw = process.env[name];
  if (!raw) return fallback;
  const [limit, windowSeconds] = raw.split("/", 2).map((part) => Number(part.trim()));
  if (!Number.isFinite(limit) || limit! <= 0) return fallback;
  return { limit: limit!, windowSeconds: Number.isFinite(windowSeconds) && windowSeconds! > 0 ? windowSeconds! : fallback.windowSeconds };
}

/**
 * Credential endpoints get a much smaller budget than ordinary reads: they are
 * unauthenticated, so the only thing standing between an attacker and every
 * password they care to try is how fast they may ask.
 *
 * Read per request rather than at import, so the value an operator sets is the
 * value in force. Computing these once at module load also made them
 * unsettable by anything that configures the process after it is imported.
 * Tunable as "limit/windowSeconds": the right numbers depend on how a
 * deployment is fronted and how many people share an address.
 */
function budgetFor(name: BudgetName): RateLimit {
  return name === "credential"
    ? budgetFromEnv("MEMOAR_CREDENTIAL_RATE_LIMIT", { limit: 10, windowSeconds: 300 })
    : budgetFromEnv("MEMOAR_RATE_LIMIT", { limit: 300, windowSeconds: 60 });
}

/** Counts requests per caller per window, sharing the count across instances. */
export interface RateLimitStore {
  hit(key: string, windowSeconds: number): Promise<number>;
  /** Reads a count without spending from it. */
  peek(key: string): Promise<number>;
}

/**
 * Redis-backed so a limit means the same thing however many instances are
 * running. A per-process counter would multiply every budget by the instance
 * count, which is the same as having no limit at all once the service scales.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, windowSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    // Only the request that opened the window sets the expiry, so a burst
    // cannot keep pushing the deadline out and hold the window open forever.
    if (count === 1) await this.redis.expire(key, windowSeconds);
    return count;
  }

  async peek(key: string): Promise<number> {
    const value = await this.redis.get(key);
    return value === null ? 0 : Number(value);
  }
}

/** Used when no Redis is configured, which is development and tests. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; expiresAt: number }>();

  hit(key: string, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const existing = this.windows.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.windows.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
      // Bounded so a long-running process cannot accumulate one entry per
      // caller for the life of the service.
      if (this.windows.size > 10_000) {
        for (const [candidate, window] of this.windows) {
          if (window.expiresAt <= now) this.windows.delete(candidate);
        }
      }
      return Promise.resolve(1);
    }
    existing.count += 1;
    return Promise.resolve(existing.count);
  }

  peek(key: string): Promise<number> {
    const window = this.windows.get(key);
    return Promise.resolve(!window || window.expiresAt <= Date.now() ? 0 : window.count);
  }
}

/**
 * The account a credential request is aimed at, so guessing is counted per
 * account rather than per address. Counting only by address locks out everyone
 * behind a shared one the moment a single person mistypes a password.
 */
function credentialSubject(request: Request): string {
  const body = (request as { body?: { email?: unknown; machineId?: unknown } }).body;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : null;
  if (email) return `email:${email}`;
  const machineId = typeof body?.machineId === "string" ? body.machineId : null;
  return machineId ? `machine:${machineId}` : "anonymous";
}

/**
 * Identifies the caller.
 *
 * An authenticated caller is counted by tenant, so one tenant cannot exhaust
 * another's budget from a shared address. Everyone else is counted by client
 * address, which is what an unauthenticated endpoint has to work with.
 */
function callerKey(request: Request): string {
  const tenant = (request as { tenantContext?: { tenantId?: string } }).tenantContext?.tenantId;
  if (tenant) return `tenant:${tenant}`;
  // request.ip, never the forwarded header directly: Express only reads that
  // header when the deployment says a proxy is in front of it. Reading it
  // regardless let anyone claim a new address per attempt, and a limit a caller
  // can opt out of by setting a header is not a limit.
  return `ip:${request.ip ?? "unknown"}`;
}

/** Key under which failed credential attempts against one account are counted. */
export function credentialFailureKey(request: Request): string {
  const pattern = (request as { route?: { path?: string } }).route?.path ?? request.path;
  return `${RATE_LIMIT_KEY}:failed:${pattern}:${credentialSubject(request)}:${callerKey(request)}`;
}

function tooMany(response: Response, windowSeconds: number): HttpException {
  response.setHeader("Retry-After", windowSeconds);
  return new HttpException({
    type: "https://memoar.dev/problems/rate-limited",
    title: "Too many requests",
    status: HttpStatus.TOO_MANY_REQUESTS,
    detail: `Try again in ${windowSeconds} seconds.`,
  }, HttpStatus.TOO_MANY_REQUESTS);
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const name = this.reflector.getAllAndOverride<BudgetName>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? "default";
    // Every route gets the ordinary budget, which is about the volume one
    // caller may generate. The credential budget is a different question — how
    // often somebody may be *wrong* about an account — and is checked below
    // against failures rather than against requests, so signing in successfully
    // as often as you like costs nothing.
    const flood = budgetFor("default");

    // The route pattern, not the concrete path, so a per-session URL cannot be
    // used to mint a fresh budget for every request.
    const pattern = (request as { route?: { path?: string } }).route?.path ?? request.path;
    const route = `${request.method}:${pattern}`;
    const count = await this.store.hit(`${RATE_LIMIT_KEY}:${route}:${callerKey(request)}`, flood.windowSeconds);

    response.setHeader("RateLimit-Limit", flood.limit);
    response.setHeader("RateLimit-Remaining", Math.max(0, flood.limit - count));
    if (count > flood.limit) {
      rateLimitRejections.inc({ limit: "flood" });
      throw tooMany(response, flood.windowSeconds);
    }

    if (name !== "credential") return true;
    const budget = budgetFor("credential");

    // Guessing is measured in failures, not in requests. Counting every attempt
    // locks out the person who signs in repeatedly for legitimate reasons while
    // barely inconveniencing an attacker, who only needs one success anyway.
    const failures = await this.store.peek(credentialFailureKey(request));
    if (failures >= budget.limit) {
      // Describe the budget that actually refused, not the flood budget.
      response.setHeader("RateLimit-Limit", budget.limit);
      response.setHeader("RateLimit-Remaining", 0);
      // Separate from the flood label: a rising credential count is somebody
      // working through passwords, which is a different alarm from a client
      // that is merely too busy.
      rateLimitRejections.inc({ limit: "credential" });
      throw tooMany(response, budget.windowSeconds);
    }
    return true;
  }
}

/**
 * Records a failed credential attempt.
 *
 * The guard refuses once too many attempts against one account have failed, so
 * something has to notice the failures. A successful sign-in costs nothing,
 * which is what keeps the limit from punishing the person who signs in often.
 */
/** The statuses that mean a credential was offered and refused. */
const REJECTED_CREDENTIAL: readonly number[] = [HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN];

@Injectable()
export class CredentialFailureInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const name = this.reflector.getAllAndOverride<BudgetName>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (context.getType() !== "http" || name !== "credential") return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const window = budgetFor("credential").windowSeconds;
    return next.handle().pipe(
      catchError((error: unknown) => {
        const status = error instanceof HttpException ? error.getStatus() : 0;
        // Only a rejected credential counts. A malformed body is the caller
        // getting the shape wrong, not an attempt at somebody's account.
        if (REJECTED_CREDENTIAL.includes(status)) {
          void this.store.hit(credentialFailureKey(request), window);
        }
        return throwError(() => error);
      }),
    );
  }
}
