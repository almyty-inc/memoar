import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Server } from "node:http";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/main.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Parsed JSON response body, indexable for assertions without `any`. */
export interface JsonBody { [key: string]: JsonValue | undefined }

/** Narrows a JSON field to an array of objects (e.g. paginated `items`). */
export function arr(body: JsonBody, key = "items"): JsonBody[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new Error(`expected ${key} to be an array, got ${JSON.stringify(value)}`);
  return value as JsonBody[];
}

/** Narrows a JSON field to a string (e.g. an id used in the next request). */
export function str(body: JsonBody, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new Error(`expected ${key} to be a string, got ${JSON.stringify(value)}`);
  return value;
}

/** Narrows a JSON field to a nested object. */
export function obj(body: JsonBody, key: string): JsonBody {
  const value = body[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${key} to be an object, got ${JSON.stringify(value)}`);
  }
  return value;
}

export interface RequestOptions {
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
}

export interface TestResponse {
  status: number;
  body: JsonBody;
}

export interface TestApi {
  app: INestApplication;
  baseUrl: string;
  token: string;
  /** Authenticated request against /v1; returns status and parsed body. */
  request(method: string, path: string, options?: RequestOptions): Promise<TestResponse>;
  close(): Promise<void>;
}

/**
 * Boots the real AppModule against in-memory adapters and logs in as the demo
 * user. Tests built on this exercise the production wiring: guards, scopes,
 * the global ValidationPipe, route prefixes, and status codes.
 */
export async function startTestApi(env: Record<string, string> = {}): Promise<TestApi> {
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  delete process.env.S3_ENDPOINT;
  process.env.NODE_ENV = "test";
  process.env.MEMOAR_SEED_DEMO = "true";
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  const app = await NestFactory.create(AppModule, { logger: ["error"], abortOnError: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  const address = (app.getHttpServer() as Server).address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const call = async (
    method: string,
    path: string,
    options: RequestOptions = {},
    bearer?: string,
  ): Promise<TestResponse> => {
    const token = options.token === undefined ? bearer : options.token;
    const response = await fetch(`${baseUrl}${path.startsWith("/v1") || path === "/health" || path === "/openapi.json" ? path : `/v1${path}`}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as JsonBody };
  };

  const login = await call("POST", "/auth/login", { body: { email: "demo@memoar.dev", password: "memoar-demo-password" }, token: null });
  if (login.status !== 200) throw new Error(`test login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const token = str(login.body, "accessToken");

  return {
    app,
    baseUrl,
    token,
    request: (method, path, options) => call(method, path, options, token),
    close: () => app.close(),
  };
}

/** The demo session seeded into every test app. */
export const DEMO_SESSION_ID = "0191cafe-0000-7000-8000-00000000d001";
