import "reflect-metadata";
import { RequestMethod, ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { raw } from "express";
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
  app.enableCors({ origin: process.env.WEB_ORIGIN?.split(",") ?? true, credentials: true });
  app.enableShutdownHooks();
}

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 4000), "0.0.0.0");
}