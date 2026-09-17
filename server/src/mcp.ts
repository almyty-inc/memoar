import { Body, Controller, ForbiddenException, Get, Inject, Injectable, Post, Req, Res } from "@nestjs/common";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { Redis } from "ioredis";
import { CONTRACT_VERSION } from "../libs/canonical/src/generated.js";
import type { TenantContext } from "./archive-store.js";
import { RequireScopes, Tenant, TokenService } from "./auth.js";
import { McpHandshakeDto } from "./mcp.dto.js";
import { McpToolRegistry } from "./mcp/registry.js";

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
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : "tool_failed" }],
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

/** An hour: long enough for a session, short enough to be worth expiring. */
const MCP_TOKEN_TTL_SECONDS = 3600;

@Controller("mcp/auth")
export class McpHandshakeController {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(McpToolRegistry) private readonly registry: McpToolRegistry,
  ) {}

  /**
   * Exchanges an API key for a short-lived bearer token.
   *
   * The MCP endpoint authenticates an API key through the x-memoar-key header,
   * and a client that cannot send a custom header — Codex, which takes only a
   * bearer token from an environment variable — had no way in. This says so in
   * a token rather than in documentation: the handshake was documented as
   * minting one and never did.
   *
   * The token carries mcp:use alone, so a leaked one reads no archive directly.
   */
  @Post("handshake")
  @RequireScopes("mcp:use")
  handshake(@Tenant() context: TenantContext, @Body() body: McpHandshakeDto): Record<string, unknown> {
    if (context.authType !== "api_key" && context.authType !== "dev") {
      // Was `throw new Error(...)`, which is a 500: the caller used the wrong
      // kind of credential, which is theirs to fix and ours to say plainly.
      throw new ForbiddenException({
        type: "https://memoar.dev/problems/api-key-required",
        title: "API key required",
        status: 403,
        code: "mcp_api_key_required",
        detail: "The MCP handshake exchanges an API key for a session token; sign in with an API key instead.",
      });
    }
    const issued = this.tokens.issue(
      { sub: context.userId, tenantId: context.tenantId, scopes: ["mcp:use"], type: "browser" },
      MCP_TOKEN_TTL_SECONDS,
    );
    return {
      endpoint: "/mcp",
      tools: this.registry.names,
      clientName: body.clientName,
      protocolVersion: body.protocolVersion,
      accessToken: issued.token,
      expiresAt: issued.expiresAt,
    };
  }
}
