import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
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
  const forwarded = request.headers["x-forwarded-for"];
  const address = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim()
    ?? request.ip
    ?? "unknown";
  return `ip:${address}`;
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
    const budget = budgetFor(this.reflector.getAllAndOverride<BudgetName>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? "default");

    // The route pattern, not the concrete path, so a per-session URL cannot be
    // used to mint a fresh budget for every request.
    const pattern = (request as { route?: { path?: string } }).route?.path ?? request.path;
    const route = `${request.method}:${pattern}`;
    const key = `${RATE_LIMIT_KEY}:${route}:${callerKey(request)}`;
    const count = await this.store.hit(key, budget.windowSeconds);

    const response = http.getResponse<Response>();
    response.setHeader("RateLimit-Limit", budget.limit);
    response.setHeader("RateLimit-Remaining", Math.max(0, budget.limit - count));
    if (count <= budget.limit) return true;

    response.setHeader("Retry-After", budget.windowSeconds);
    throw new HttpException({
      type: "https://memoar.dev/problems/rate-limited",
      title: "Too many requests",
      status: HttpStatus.TOO_MANY_REQUESTS,
      detail: `Try again in ${budget.windowSeconds} seconds.`,
    }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
