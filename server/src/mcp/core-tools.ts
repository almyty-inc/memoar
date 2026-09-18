import { Inject, Injectable } from "@nestjs/common";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ArchiveStore, TenantContext } from "../archive-store.js";
import { AnnotationService } from "../annotations/annotations.service.js";
import { CollectionService } from "../collections/collections.service.js";
import { PackService, SearchService } from "../search.js";
import { BuildPackDto } from "../search/search.dto.js";
import { SessionsService } from "../sessions.js";
import { TeamWorkspaceService } from "../team-workspace.js";
import { ARCHIVE_STORE } from "../tokens.js";
import { parseToolArguments } from "./arguments.js";
import {
  GetExcerptDto, GetMemoryDto, GetSessionDto, ListCollectionsDto, SaveNoteDto, SearchSessionsDto,
} from "./core-tools.dto.js";
import { pageSize, toolNames, type McpToolGroup } from "./tool-group.js";

const DEFAULT_COLLECTION_LIMIT = 50;

export const CORE_TOOLS: readonly Tool[] = [
  {
    name: "search_sessions",
    description: "Start here. Search summaries across the archive, optionally narrowed by agent, workspace or date. Results are fields-minimal and cheaper than reading a session.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", maxLength: 1_000 },
        mode: { enum: ["hybrid", "lexical", "semantic"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        agent: { type: "string", maxLength: 100, description: "Capture tool, e.g. claude-code or codex. From list_sessions or the aggregations this tool returns." },
        workspace: { type: "string", maxLength: 4_096, description: "Exact workspace path." },
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        teamId: { type: "string", description: "A team you belong to. Present, this reads that team's shared archive — teammates' sessions widened to it — instead of your own." },
      },
    },
  },
  {
    name: "get_excerpt",
    description: "Read a bounded turn span after search. Prefer this before pack when one session is enough.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "turnStart", "turnEnd"],
      properties: {
        sessionId: { type: "string" },
        turnStart: { type: "integer", minimum: 0 },
        turnEnd: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 200, maximum: 20_000 },
        teamId: { type: "string", description: "A team you belong to. Present, this reads that team's shared archive — teammates' sessions widened to it — instead of your own." },
      },
    },
  },
  {
    name: "pack",
    description: "Build cited evidence under an explicit token budget. Use for synthesis across sessions. Redaction and evidence age stay structured.",
    inputSchema: {
      type: "object",
      required: ["query", "maxTokens", "maxEvidence", "maxSessions", "maxExcerptChars", "freshnessPolicy"],
      properties: {
        query: { type: "string" },
        maxTokens: { type: "integer", minimum: 64, maximum: 32_000 },
        maxEvidence: { type: "integer", minimum: 1, maximum: 100 },
        maxSessions: { type: "integer", minimum: 1, maximum: 50 },
        maxExcerptChars: { type: "integer", minimum: 80, maximum: 20_000 },
        freshnessPolicy: { enum: ["strict", "mixed"] },
        staleAfterDays: { type: "integer", minimum: 1 },
      },
    },
  },
  {
    name: "get_session",
    description: "Last resort. Read one chunk of a full session. Continue with the returned cursor and keep chunkSize small.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        cursor: { type: "string", maxLength: 200 },
        chunkSize: { type: "integer", minimum: 1, maximum: 200 },
        teamId: { type: "string", description: "A team you belong to. Present, this reads that team's shared archive — teammates' sessions widened to it — instead of your own." },
      },
    },
  },
  {
    name: "list_collections",
    description: "List curated collections visible to the active tenant.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200, description: `Default ${DEFAULT_COLLECTION_LIMIT}.` } } },
  },
  {
    name: "get_memory",
    description: "Retrieve a compact cited pack for a topic using conservative defaults. Packs sessions; for the captured CLAUDE.md / AGENTS.md files use list_memory_documents.",
    inputSchema: { type: "object", required: ["topic"], properties: { topic: { type: "string", maxLength: 1_000 }, maxTokens: { type: "integer", minimum: 64, maximum: 8_000 } } },
  },
  {
    name: "save_note",
    description: "Save a durable note linked to a source session after significant work.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "markdown"],
      properties: { sessionId: { type: "string" }, markdown: { type: "string", maxLength: 20_000 }, topic: { type: "string", maxLength: 200 } },
    },
  },
] as const;

const CORE_TOOL_NAMES = toolNames(CORE_TOOLS);

/**
 * The tools that were here before parity work: search, excerpt, pack, session,
 * collections, memory pack and note.
 *
 * They read their arguments field by field through two helpers that coerced
 * silently — a `limit` of "50" became the default 10, an absent `maxTokens`
 * reached `PackService` as `undefined` and multiplied into `NaN`. Every one of
 * them now goes through `parseToolArguments`, so a malformed call is refused
 * rather than answered differently than it was asked.
 */
@Injectable()
export class McpCoreTools implements McpToolGroup {
  readonly tools = CORE_TOOLS;

  constructor(
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(PackService) private readonly packs: PackService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(CollectionService) private readonly collections: CollectionService,
    @Inject(AnnotationService) private readonly annotations: AnnotationService,
    @Inject(ARCHIVE_STORE) private readonly store: ArchiveStore,
    @Inject(TeamWorkspaceService) private readonly workspace: TeamWorkspaceService,
  ) {}

  handles(name: string): boolean {
    return CORE_TOOL_NAMES.has(name);
  }

  async call(context: TenantContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === "search_sessions") return this.searchSessions(context, args);
    if (name === "get_excerpt") return this.excerpt(context, args);
    if (name === "pack") return this.packs.build(context, parseToolArguments(BuildPackDto, args));
    if (name === "get_session") return this.session(context, args);
    if (name === "list_collections") return this.listCollections(context, args);
    if (name === "get_memory") return this.memory(context, args);
    return this.saveNote(context, args);
  }

  /**
   * Absent `teamId`, byte-identical to what this tool has always done. Present,
   * the same query runs across the team through the same service the HTTP team
   * route uses, so the membership check and the team visibility predicate are
   * the ones already proven rather than a second pair.
   */
  private async searchSessions(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(SearchSessionsDto, args);
    const limit = request.limit ?? 10;
    const filters = {
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.workspace ? { workspace: request.workspace } : {}),
      ...(request.from ? { from: new Date(request.from) } : {}),
      ...(request.to ? { to: new Date(request.to) } : {}),
    };
    if (request.teamId) return this.workspace.searchTeam(context, request.teamId, request.query, request.mode ?? "hybrid", filters, limit);
    return this.search.response(context, request.query, request.mode ?? "hybrid", filters, limit);
  }

  private async excerpt(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(GetExcerptDto, args);
    // A teammate's session is reachable only through the team, never through
    // the tenant-scoped read — that one is not loosened.
    const session = request.teamId
      ? await this.workspace.readSession(context, request.teamId, request.sessionId)
      : await this.store.getSession(context, request.sessionId);
    if (!session) throw new Error("session_not_found");
    const maximum = request.maxChars ?? 4_000;
    const turns = session.turns.filter((turn) => turn.ordinal >= request.turnStart && turn.ordinal <= request.turnEnd);
    const excerpt = turns
      .map((turn) => `[${turn.role} ${turn.ordinal}] ${turn.blocks.map((block) => block.text ?? "").join("\n")}`)
      .join("\n");
    return {
      sessionId: session.id,
      turnStart: turns[0]?.ordinal ?? request.turnStart,
      turnEnd: turns.at(-1)?.ordinal ?? request.turnEnd,
      excerpt: excerpt.slice(0, maximum),
      truncated: excerpt.length > maximum,
      redactionStatus: session.redactionStatus,
    };
  }

  private async session(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(GetSessionDto, args);
    const chunkSize = String(request.chunkSize ?? 25);
    return request.teamId
      ? this.workspace.getSession(context, request.teamId, request.sessionId, request.cursor, chunkSize)
      : this.sessions.getChunk(context, request.sessionId, request.cursor, chunkSize);
  }

  private async listCollections(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(ListCollectionsDto, args);
    const limit = pageSize(request.limit, DEFAULT_COLLECTION_LIMIT, 200);
    const { items } = await this.collections.list(context);
    return { items: items.slice(0, limit), total: items.length, limit };
  }

  private async memory(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(GetMemoryDto, args);
    return this.packs.build(context, {
      query: request.topic,
      maxTokens: request.maxTokens ?? 1_500,
      maxEvidence: 8,
      maxSessions: 4,
      maxExcerptChars: 2_000,
      freshnessPolicy: "mixed",
      staleAfterDays: 90,
    });
  }

  private async saveNote(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(SaveNoteDto, args);
    const annotation = await this.annotations.create(context, {
      sessionId: request.sessionId,
      kind: "note",
      value: { markdown: request.markdown, ...(request.topic ? { topic: request.topic } : {}), source: "mcp" },
    });
    return { annotation };
  }
}
