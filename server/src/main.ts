import "reflect-metadata";
import { RequestMethod, ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { raw, type Express } from "express";
import type { ServerResponse } from "node:http";
import { DataSource, IsNull } from "typeorm";
import { AppModule } from "./app.module.js";
import { AuthIdentityEntity } from "./entities.js";
import { errorAggregator, persistErrors } from "./errors/error-aggregator.js";
import { assertNoPublishedAccountPasswords, assertProductionCredentials } from "./startup-checks.js";

/**
 * How many proxies sit in front of this process.
 *
 * Express works out the client address from X-Forwarded-For only when it is
 * told to trust a proxy, and it trusts exactly as many hops as it is told. That
 * matters because the header is written by whoever sends the request: trusting
 * it blindly hands every caller a free choice of identity, and anything keyed
 * to the caller — the rate limit above all — is then no limit at all, since a
 * new address for each attempt buys a new budget for each attempt.
 *
 * The default is to trust nothing, which is right for a process reached
 * directly. A deployment behind one load balancer sets this to 1.
 */
function trustedProxyHops(): number {
  const raw = Number(process.env.MEMOAR_TRUSTED_PROXY_HOPS ?? 0);
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

export function configureApp(app: INestApplication): void {
  // Express falls back to the socket address when the hop count is 0, so an
  // untrusted deployment ignores the header entirely.
  (app.getHttpAdapter().getInstance() as Express).set("trust proxy", trustedProxyHops());
  app.use("/v1/ingest/artifacts", raw({
    type: "application/octet-stream",
    limit: Number(process.env.MEMOAR_MAX_ARTIFACT_BYTES ?? 64 * 1024 * 1024),
  }));
  // Request bodies are validated against the DTO declared on each handler.
  // forbidNonWhitelisted keeps unknown fields from silently reaching services.
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  }));
  app.setGlobalPrefix("v1", {
    exclude: [
      { path: "health", method: RequestMethod.GET },
      { path: "openapi.json", method: RequestMethod.GET },
      { path: "mcp", method: RequestMethod.ALL },
    ],
  });
  // CORS fails closed everywhere. `origin: true` reflects whatever Origin the
  // caller sends, which with credentials enabled lets any site on the internet
  // make authenticated requests on a user's behalf.
  //
  // Unconfigured means the local web app.s own addresses and nothing else, so
  // forgetting WEB_ORIGIN costs a developer a clear CORS error rather than
  // costing everyone else their archive.
  //
  // An empty or whitespace WEB_ORIGIN parses to an empty list, which is not
  // the same as unset and must not be treated as "allow nothing" by accident.
  const configured = (process.env.WEB_ORIGIN ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (process.env.NODE_ENV === "production" && configured.length === 0) {
    throw new Error("WEB_ORIGIN is required in production: refusing to serve a browser app from an unnamed origin");
  }
  app.enableCors({ origin: configured.length > 0 ? configured : LOCAL_ORIGINS, credentials: true });

  // Set on every response. The API serves JSON to a browser app, so the
  // headers that matter are the ones stopping a response being reinterpreted:
  // sniffed as another content type, framed by another site, or leaking the
  // path a user was on to a third party.
  app.use((_request: unknown, response: ServerResponse, next: () => void) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-site");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (process.env.NODE_ENV === "production") {
      response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });
  app.enableShutdownHooks();
}

/**
 * Where the web app runs when nobody has said otherwise.
 *
 * Both spellings of localhost and both dev ports, because a browser treats them
 * as different origins and a developer should not have to know that.
 */
export const LOCAL_ORIGINS = [
  "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:4173", "http://127.0.0.1:4173",
];

export async function bootstrap(): Promise<void> {
  // Before anything listens: a service that boots and then fails on somebody's
  // request has already announced it is up.
  assertProductionCredentials();
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // An archive upgraded from an earlier build can still hold an account that
  // build created with a published password, so this is asked of the database
  // rather than of the environment.
  const dataSource: DataSource | null = app.get(DataSource, { strict: false });
  if (dataSource) {
    await assertNoPublishedAccountPasswords(async (email) =>
      dataSource.getRepository(AuthIdentityEntity).findOneBy({ kind: "password", lookupKey: email, revokedAt: IsNull() }));
  }
  configureApp(app);
  // Failure counts carry across a restart, so "this has happened 4,000 times
  // since Tuesday" survives the deploy that was made because of it.
  const stopPersistingErrors = persistErrors(errorAggregator);
  process.once("SIGTERM", stopPersistingErrors);
  process.once("SIGINT", stopPersistingErrors);
  await app.listen(Number(process.env.PORT ?? 4000), "0.0.0.0");
}