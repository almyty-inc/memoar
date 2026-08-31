import "reflect-metadata";
import { RequestMethod, ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { raw } from "express";
import type { ServerResponse } from "node:http";
import { AppModule } from "./app.module.js";

export function configureApp(app: INestApplication): void {
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
  // CORS fails closed in production. `origin: true` reflects whatever Origin
  // the caller sends, which with credentials enabled lets any site on the
  // internet make authenticated requests on a user's behalf. Reflecting is
  // convenient for local work and unacceptable once deployed, so an explicit
  // WEB_ORIGIN is required there.
  const origins = process.env.WEB_ORIGIN?.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (process.env.NODE_ENV === "production" && (!origins || origins.length === 0)) {
    throw new Error("WEB_ORIGIN is required in production: refusing to reflect arbitrary origins with credentials");
  }
  app.enableCors({ origin: origins ?? true, credentials: true });

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

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 4000), "0.0.0.0");
}