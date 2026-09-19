import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Redis } from "ioredis";
import { AuthController, AuthGuard, AuthService, TokenService } from "./auth.js";
import { BrowserSessionService } from "./auth/browser-sessions.js";
import { CredentialsService } from "./auth/credentials.service.js";
import { CredentialFailureInterceptor, MemoryRateLimitStore, RateLimitGuard, RedisRateLimitStore, type RateLimitStore } from "./rate-limit.js";

export const RATE_LIMIT_STORE = Symbol("RATE_LIMIT_STORE");

@Module({
  controllers: [AuthController],
  providers: [
    TokenService,
    BrowserSessionService,
    CredentialsService,
    AuthService,
    AuthGuard,
    {
      provide: RATE_LIMIT_STORE,
      useFactory: (): RateLimitStore => {
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) return new RedisRateLimitStore(new Redis(redisUrl, { maxRetriesPerRequest: 1 }));
        // A per-process counter multiplies every budget by the instance count,
        // which is no limit at all once the service runs on more than one.
        if (process.env.NODE_ENV === "production") {
          throw new Error("REDIS_URL is required in production: an in-process rate limit does not hold across instances");
        }
        return new MemoryRateLimitStore();
      },
    },
    {
      // Ordered before the auth guard so an unauthenticated flood is refused
      // without the cost of verifying a token it was never going to have.
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, store: RateLimitStore) => new RateLimitGuard(reflector, store),
      inject: [Reflector, RATE_LIMIT_STORE],
    },
    { provide: APP_GUARD, useExisting: AuthGuard },
    {
      provide: APP_INTERCEPTOR,
      useFactory: (reflector: Reflector, store: RateLimitStore) => new CredentialFailureInterceptor(reflector, store),
      inject: [Reflector, RATE_LIMIT_STORE],
    },
  ],
  exports: [TokenService, AuthService, AuthGuard],
})
export class AuthModule {}
