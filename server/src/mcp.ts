import { Body, Controller, Get, Inject, Injectable, Post, Req, Res } from "@nestjs/common";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { Redis } from "ioredis";
import { CONTRACT_VERSION } from "../libs/canonical/src/generated.js";
import type { ArchiveStore, TenantContext } from "./archive-store.js";
import { Tenant } from "./auth.js";
import { AnnotationService, CollectionService } from "./curation.js";
import { PackService, SearchService, type PackRequest } from "./search.js";
import { SessionsService } from "./sessions.js";
import { ARCHIVE_STORE } from "./tokens.js";

const TOOLS: readonly Tool[] = [
  {
    name: "search_sessions",
    description: "Start here. Search summaries across the archive. Results are fields-minimal and cheaper than reading a session.",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, mode: { enum: ["hybrid", "lexical", "semantic"] }, limit: { type: "integer", minimum: 1, maximum: 50 } } },
  },
  {
    name: "get_excerpt",
    description: "Read a bounded turn span after search. Prefer this before pack when one session is enough.",
    inputSchema: { type: "object", required: ["sessionId", "turnStart", "turnEnd"], properties: { sessionId: { type: "string" }, turnStart: { type: "integer" }, turnEnd: { type: "integer" }, maxChars: { type: "integer", maximum: 20000 } } },
  },
  {
    name: "pack",
    description: "Build cited evidence under an explicit token budget. Use for synthesis across sessions. Redaction and evidence age stay structured.",
    inputSchema: { type: "object", required: ["query", "maxTokens", "maxEvidence", "maxSessions", "maxExcerptChars", "freshnessPolicy"], properties: { query: { type: "string" }, maxTokens: { type: "integer" }, maxEvidence: { type: "integer" }, maxSessions: { type: "integer" }, maxExcerptChars: { type: "integer" }, freshnessPolicy: { enum: ["strict", "mixed"] }, staleAfterDays: { type: "integer" } } },
  },
  {
    name: "get_session",
    description: "Last resort. Read one chunk of a full session. Continue with the returned cursor and keep chunkSize small.",
    inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, cursor: { type: "string" }, chunkSize: { type: "integer", maximum: 200 } } },
  },
  { name: "list_collections", description: "List curated collections visible to the active tenant.", inputSchema: { type: "object", properties: {} } },
  { name: "get_memory", description: "Retrieve a compact cited pack for a topic using conservative defaults.", inputSchema: { type: "object", required: ["topic"], properties: { topic: { type: "string" }, maxTokens: { type: "integer" } } } },
  { name: "save_note", description: "Save a durable note linked to a source session after significant work.", inputSchema: { type: "object", required: ["sessionId", "markdown"], properties: { sessionId: { type: "string" }, markdown: { type: "string" }, topic: { type: "string" } } } },
] as const;

function stringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value) throw new Error(`invalid_argument:${name}`);
  return value;
}

function numberArgument(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

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

@Injectable()
export class McpService {
  constructor(
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(PackService) private readonly packs: PackService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(CollectionService) private readonly collections: CollectionService,
    @Inject(AnnotationService) private readonly annotations: AnnotationService,
    @Inject(ARCHIVE_STORE) private readonly store: ArchiveStore,
  ) {}

  createServer(context: TenantContext): Server {
    const server = new Server(
      { name: "memoar", version: CONTRACT_VERSION },
      { capabilities: { tools: { listChanged: false } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOLS] }));
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

  async callTool(context: TenantContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === "search_sessions") {
      const modeValue = args.mode;
      const mode = modeValue === "lexical" || modeValue === "semantic" ? modeValue : "hybrid";
      return this.search.response(context, stringArgument(args, "query"), mode, {}, Math.min(50, numberArgument(args, "limit", 10)));
    }
    if (name === "get_excerpt") {
      const session = await this.store.getSession(context, stringArgument(args, "sessionId"));
      if (!session) throw new Error("session_not_found");
      const start = numberArgument(args, "turnStart", 0);
      const end = numberArgument(args, "turnEnd", start);
      const maximum = Math.min(20_000, numberArgument(args, "maxChars", 4_000));
      const turns = session.turns.filter((turn) => turn.ordinal >= start && turn.ordinal <= end);
      return {
        sessionId: session.id,
        turnStart: turns[0]?.ordinal ?? start,
        turnEnd: turns.at(-1)?.ordinal ?? end,
        excerpt: turns.map((turn) => `[${turn.role} ${turn.ordinal}] ${turn.blocks.map((block) => block.text ?? "").join("\n")}`).join("\n").slice(0, maximum),
        redactionStatus: session.redactionStatus,
      };
    }
    if (name === "pack") return this.packs.build(context, args as unknown as PackRequest);
    if (name === "get_session") return this.sessions.getChunk(
      context,
      stringArgument(args, "sessionId"),
      typeof args.cursor === "string" ? args.cursor : undefined,
      String(numberArgument(args, "chunkSize", 25)),
    );
    if (name === "list_collections") return this.collections.list(context);
    if (name === "get_memory") return this.packs.build(context, {
      query: stringArgument(args, "topic"),
      maxTokens: Math.min(8_000, numberArgument(args, "maxTokens", 1_500)),
      maxEvidence: 8,
      maxSessions: 4,
      maxExcerptChars: 2_000,
      freshnessPolicy: "mixed",
      staleAfterDays: 90,
    });
    if (name === "save_note") {
      const annotation = await this.annotations.create(context, {
        sessionId: stringArgument(args, "sessionId"),
        kind: "note",
        value: {
          markdown: stringArgument(args, "markdown"),
          ...(typeof args.topic === "string" ? { topic: args.topic } : {}),
          source: "mcp",
        },
      });
      return { annotation };
    }
    throw new Error(`unknown_tool:${name}`);
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

@Controller("mcp/auth")
export class McpHandshakeController {
  @Post("handshake")
  handshake(@Tenant() context: TenantContext, @Body() body: { clientName: string; protocolVersion: string }): Record<string, unknown> {
    if (context.authType !== "api_key" && context.authType !== "dev") throw new Error("mcp_api_key_required");
    return { endpoint: "/mcp", tools: TOOLS.map((tool) => tool.name), clientName: body.clientName, protocolVersion: body.protocolVersion };
  }
}
