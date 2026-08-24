import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CanActivate, type ExecutionContext, type INestApplication, Injectable, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnnotationService, CollectionService } from "../src/curation.js";
import { DEMO_CONTEXT, DEMO_SESSION } from "../src/demo-data.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { configureApp } from "../src/main.js";
import { McpController, McpRateLimiter, McpService } from "../src/mcp.js";
import { DeterministicLexicalBackend, DisabledSemanticSearchProvider, PackService, SearchService } from "../src/search.js";
import { SessionsService } from "../src/sessions.js";
import { ARCHIVE_STORE, SEARCH_BACKEND, SEMANTIC_SEARCH_PROVIDER } from "../src/tokens.js";

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ tenantContext?: unknown }>().tenantContext = DEMO_CONTEXT;
    return true;
  }
}

const store = new DevArchiveStore();

@Module({
  controllers: [McpController],
  providers: [
    { provide: ARCHIVE_STORE, useValue: store },
    { provide: SEARCH_BACKEND, useFactory: () => new DeterministicLexicalBackend(store) },
    { provide: SEMANTIC_SEARCH_PROVIDER, useFactory: () => new DisabledSemanticSearchProvider() },
    SearchService,
    { provide: PackService, useFactory: (search: SearchService) => new PackService(search, () => new Date("2026-08-19T00:00:00.000Z")), inject: [SearchService] },
    { provide: SessionsService, useFactory: () => new SessionsService(store) },
    { provide: CollectionService, useFactory: () => new CollectionService(store) },
    { provide: AnnotationService, useFactory: () => new AnnotationService(store) },
    McpService,
    { provide: McpRateLimiter, useFactory: () => new McpRateLimiter(5, 60_000, null) },
    { provide: APP_GUARD, useClass: TestAuthGuard },
  ],
})
class TestMcpModule {}

describe("MCP over Streamable HTTP with the official SDK client", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    await store.saveSession(DEMO_CONTEXT, DEMO_SESSION);
    app = await NestFactory.create(TestMcpModule, { logger: ["error"], abortOnError: false });
    configureApp(app);
    await app.listen(0, "127.0.0.1");
    const server = app.getHttpServer() as Server;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => { if (app) await app.close(); });

  it("initializes, lists tools, calls tools, and saves notes through the real SDK client", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "memoar-sdk-test", version: "0.0.1" });
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

    const serverVersion = client.getServerVersion();
    expect(serverVersion).toMatchObject({ name: "memoar" });

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "search_sessions", "get_excerpt", "pack", "get_session", "list_collections", "get_memory", "save_note",
    ]);
    expect(listed.tools.find((tool) => tool.name === "search_sessions")!.description).toContain("Start here");
    expect(listed.tools.find((tool) => tool.name === "get_session")!.description).toContain("Last resort");

    const searched = await client.callTool({ name: "search_sessions", arguments: { query: "archive parser", limit: 5 } });
    const structured = searched.structuredContent as { items: { id: string }[]; meta: { realizedMode: string } };
    expect(structured.items[0]!.id).toBe(DEMO_SESSION.id);
    expect(structured.meta.realizedMode).toBe("lexical");

    const saved = await client.callTool({ name: "save_note", arguments: { sessionId: DEMO_SESSION.id, markdown: "Keep the raw artifact before parsing." } });
    expect(saved.isError).toBeFalsy();
    expect(await store.listAnnotations(DEMO_CONTEXT, DEMO_SESSION.id)).toHaveLength(1);

    await client.close();
  });

  it("returns a JSON-RPC error body with HTTP 429 once the fixed window is exhausted", async () => {
    const post = () => fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
    });
    let response = await post();
    while (response.status !== 429) response = await post();
    expect(response.status).toBe(429);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({ jsonrpc: "2.0", id: 9, error: { code: -32000 } });
  });
});
