import { Body, Controller, Get, Inject, Injectable, Post, Req, Res } from "@nestjs/common";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { Redis } from "ioredis";
import { CONTRACT_VERSION } from "../libs/canonical/src/generated.js";
import type { TenantContext } from "./archive-store.js";
import { Tenant } from "./auth.js";
import { McpToolRegistry } from "./mcp/registry.js";
import { toolErrorText } from "./mcp/tool-error.js";

function requestIdOf(body: unknown): string | number | null {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

@Injectable()
export class McpRateLimiter {
  private readonly windows = new Map<string, { window: number; count: number }>();
  private readonly redis: Redis | null;

  constructor(
    private readonly maximum = 120,
    private readonly windowMs = 60_000,
    redisUrl: string | null = process.env.REDIS_URL ?? null,
  ) {
    this.redis = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: 1 }) : null;
  }

  /** Fixed-window counter. Redis INCR is atomic across API replicas; the window number is part of the key so resets race-free. */
  async consume(key: string): Promise<boolean> {
    const window = Math.floor(Date.now() / this.windowMs);
    if (this.redis) {
      const bucket = `mcp:rate:${key}:${window}`;
      const count = await this.redis.incr(bucket);
      if (count === 1) await this.redis.pexpire(bucket, this.windowMs * 2);
      return count <= this.maximum;
    }
    const current = this.windows.get(key);
    if (!current || current.window !== window) {
      this.windows.set(key, { window, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.maximum;
  }

  async shutdown(): Promise<void> {
    if (this.redis) await this.redis.quit();
  }
}

/**
 * The MCP server itself: transport, dispatch and error shape.
 *
 * The tools live in `./mcp/*-tools.ts` and are assembled by `McpToolRegistry`.
 * This class knows how to run a session, not what the archive can do.
 */
@Injectable()
export class McpService {
  constructor(@Inject(McpToolRegistry) private readonly registry: McpToolRegistry) {}

  createServer(context: TenantContext): Server {
    const server = new Server(
      { name: "memoar", version: CONTRACT_VERSION },
      { capabilities: { tools: { listChanged: false } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.registry.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const result = await this.callTool(context, request.params.name, request.params.arguments ?? {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, isError: false };
      } catch (error) {
        return {
          // Not `error.message`: a problem-details refusal carries its reason
          // in `code` and `detail`, and `message` is the exception class name.
          // See `toolErrorText`.
          content: [{ type: "text" as const, text: toolErrorText(error) }],
          isError: true,
        };
      }
    });
    return server;
  }

  callTool(context: TenantContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.registry.call(context, name, args);
  }
}

@Controller("mcp")
export class McpController {
  constructor(
    @Inject(McpService) private readonly mcp: McpService,
    @Inject(McpRateLimiter) private readonly limiter: McpRateLimiter,
  ) {}

  @Post()
  async post(
    @Tenant() context: TenantContext,
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const allowed = await this.limiter.consume(`${context.tenantId}:${context.userId}`);
    if (!allowed) {
      response.status(429).json({
        jsonrpc: "2.0",
        id: requestIdOf(body),
        error: { code: -32000, message: "MCP session rate limit exceeded" },
      });
      return;
    }
    const server = this.mcp.createServer(context);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
    await transport.handleRequest(request, response, body);
  }

  @Get()
  get(@Tenant() context: TenantContext): Record<string, unknown> {
    return { protocol: "mcp-streamable-http", version: CONTRACT_VERSION, tenantId: context.tenantId };
  }
}

// The handshake controller lives in ./mcp/handshake.controller.ts; re-exported
// here so the module's controller list reads as one import.
export { McpHandshakeController } from "./mcp/handshake.controller.js";
