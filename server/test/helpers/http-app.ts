import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Server } from "node:http";
import { AppModule } from "../../src/app.module.js";
import type { ArchiveStore, TenantContext } from "../../src/archive-store.js";
import { bootstrapAccount } from "../../src/bootstrap-account.js";
import { configureApp } from "../../src/main.js";
import { ARCHIVE_STORE } from "../../src/tokens.js";
import { TEST_SESSION } from "../fixtures/archive.js";

/** The account every HTTP test signs in as. Not a default anywhere in src/. */
export const TEST_ACCOUNT = { email: "owner@memoar.test", password: "test-account-password-not-a-default" };

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
  /** Response headers, for assertions about caching, limits and the like. */
  headers: Headers;
}

export interface TestApi {
  app: INestApplication;
  baseUrl: string;
  token: string;
  /**
   * The tenant the token belongs to. A test that writes straight to the store
   * must write here, or it will archive into one tenant and read as another —
   * and see an empty archive that looks exactly like a broken query.
   */
  context: TenantContext;
  /** Authenticated request against /v1; returns status and parsed body. */
  request(method: string, path: string, options?: RequestOptions): Promise<TestResponse>;
  close(): Promise<void>;
}

/**
 * Boots the real AppModule against in-memory adapters and logs in as the test
 * user. Tests built on this exercise the production wiring: guards, scopes,
 * the global ValidationPipe, route prefixes, and status codes.
 */
export async function startTestApi(env: Record<string, string> = {}): Promise<TestApi> {
  // A suite makes far more requests from one address than a person would, so
  // the budget is raised here; that the limit works is proven in rate-limit.test.
  process.env.MEMOAR_RATE_LIMIT ??= "100000/60";
  process.env.MEMOAR_CREDENTIAL_RATE_LIMIT ??= "100000/60";
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  delete process.env.S3_ENDPOINT;
  process.env.NODE_ENV = "test";
  // The suite signs in as a real account rather than relying on a back door,
  // and asks for the development conveniences by name — they are off unless
  // something says otherwise, which is the whole point of the switch.
  process.env.MEMOAR_DEV_AUTH = "true";
  process.env.MEMOAR_BOOTSTRAP_EMAIL = TEST_ACCOUNT.email;
  process.env.MEMOAR_BOOTSTRAP_PASSWORD = TEST_ACCOUNT.password;
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
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as JsonBody, headers: response.headers };
  };

  const login = await call("POST", "/auth/login", { body: { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password }, token: null });
  if (login.status !== 200) throw new Error(`test login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const token = str(login.body, "accessToken");

  // The archive no longer seeds itself, so a test that needs a session in it
  // puts one there. Written as the account that just signed in, or the HTTP
  // tests would be reading another tenant's archive and finding nothing.
  const account = bootstrapAccount();
  if (!account) throw new Error("the test account was not configured");
  const context: TenantContext = {
    tenantId: account.tenantId, userId: account.userId, scopes: ["*"], authType: "dev",
  };
  await app.get<ArchiveStore>(ARCHIVE_STORE).saveSession(context, {
    ...TEST_SESSION,
    visibility: { scope: "private", ownerId: account.userId },
  });

  return {
    app,
    baseUrl,
    token,
    context,
    request: (method, path, options) => call(method, path, options, token),
    close: () => app.close(),
  };
}

/** The fixture session this helper writes into every test app's archive. */
export const FIXTURE_SESSION_ID = TEST_SESSION.id;
