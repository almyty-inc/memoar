import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CanActivate, type ExecutionContext, type INestApplication, Injectable, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { configureApp } from "../src/main.js";
import { McpController, McpRateLimiter, McpService } from "../src/mcp.js";
import { McpToolRegistry } from "../src/mcp/registry.js";
import { buildRegistry } from "./mcp-fixture.js";

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ tenantContext?: unknown }>().tenantContext = TEST_CONTEXT;
    return true;
  }
}

const store = new DevArchiveStore();

@Module({
  controllers: [McpController],
  providers: [
    { provide: McpToolRegistry, useFactory: () => buildRegistry(store) },
    McpService,
    // Small, so the 429 test exhausts it quickly; large enough for the tool calls
    // the first test makes through one client.
    { provide: McpRateLimiter, useFactory: () => new McpRateLimiter(20, 60_000, null) },
    { provide: APP_GUARD, useClass: TestAuthGuard },
  ],
})
class TestMcpModule {}

describe("MCP over Streamable HTTP with the official SDK client", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    await store.saveSession(TEST_CONTEXT, TEST_SESSION);
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
      "list_sessions", "list_machines",
      "list_annotations", "add_annotation",
      "create_collection", "list_collection_sessions", "add_session_to_collection", "remove_session_from_collection",
      "list_share_links", "list_transfers",
      "export_project_memory",
      "list_memory_documents", "get_memory_document",
    ]);
    expect(listed.tools.find((tool) => tool.name === "search_sessions")!.description).toContain("Start here");
    expect(listed.tools.find((tool) => tool.name === "get_session")!.description).toContain("Last resort");

    const searched = await client.callTool({ name: "search_sessions", arguments: { query: "archive parser", limit: 5 } });
    const structured = searched.structuredContent as { items: { id: string }[]; meta: { realizedMode: string } };
    expect(structured.items[0]!.id).toBe(TEST_SESSION.id);
    expect(structured.meta.realizedMode).toBe("lexical");

    // The instruction files are reachable over MCP too, through the same
    // server and the same tenant context as the session tools.
    await store.captureMemoryDocument(TEST_CONTEXT, {
      scope: "project",
      machineId: TEST_SESSION.source.machineId,
      workspacePath: "/workspace/memoar",
      path: "/workspace/memoar/AGENTS.md",
      title: "AGENTS.md",
      readers: ["codex"],
      contentHash: "a".repeat(64),
      text: "Small files. Real coverage.",
      capturedAt: "2026-08-19T00:00:00.000Z",
      visibility: { scope: "private", ownerId: TEST_CONTEXT.userId },
    });
    const documents = await client.callTool({ name: "list_memory_documents", arguments: { pathPattern: "AGENTS.md" } });
    const listedDocuments = documents.structuredContent as { items: { id: string; path: string }[]; total: number };
    expect(listedDocuments.items.map((document) => document.path)).toEqual(["/workspace/memoar/AGENTS.md"]);

    const document = await client.callTool({ name: "get_memory_document", arguments: { documentId: listedDocuments.items[0]!.id } });
    expect((document.structuredContent as { content: { text: string } }).content.text).toBe("Small files. Real coverage.");

    const refused = await client.callTool({ name: "get_memory_document", arguments: { documentId: "not-a-uuid" } });
    expect(refused.isError, "a malformed argument is the caller's error, not a document").toBe(true);

    const saved = await client.callTool({ name: "save_note", arguments: { sessionId: TEST_SESSION.id, markdown: "Keep the raw artifact before parsing." } });
    expect(saved.isError).toBeFalsy();
    expect(await store.listAnnotations(TEST_CONTEXT, TEST_SESSION.id)).toHaveLength(1);

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
