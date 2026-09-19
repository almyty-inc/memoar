import { Body, Controller, Get, HttpCode, Inject, Injectable, Optional, Post, Query } from "@nestjs/common";
import type { RedactionStatus, TenantContext } from "../archive-store.js";
import { Tenant } from "../auth.js";
import { sessionSummary } from "../sessions.js";
import { SEARCH_BACKEND, SEMANTIC_SEARCH_PROVIDER } from "../tokens.js";
import type { SearchBackend, SearchCandidate, SearchFilters } from "./backends.js";
import type { SemanticSearchProvider } from "./embeddings.js";
import { BuildPackDto, SearchQueryDto } from "./search.dto.js";

/**
 * Reciprocal rank fusion over any number of ranked lists.
 *
 * It used to take exactly two, lexical and semantic, which is all a
 * single-tenant search has. A team search has one pair *per member tenant*, and
 * their raw scores are not comparable across tenants — a ts_rank from one
 * archive means nothing against a ts_rank from another. RRF only reads
 * positions, so feeding it the lists separately fuses them without ever
 * pretending the scores line up. Two lists in, behaviour is unchanged.
 */
export function fuse(...lists: readonly (readonly SearchCandidate[])[]): SearchCandidate[] {
  const fused = new Map<string, SearchCandidate & { fused: number }>();
  for (const list of lists) {
    for (const [index, candidate] of list.entries()) {
      const current = fused.get(candidate.session.id);
      if (current) current.fused += 1 / (60 + index + 1);
      else fused.set(candidate.session.id, { ...candidate, fused: 1 / (60 + index + 1) });
    }
  }
  return [...fused.values()].sort((left, right) => right.fused - left.fused || left.session.id.localeCompare(right.session.id))
    .map(({ fused: score, ...candidate }) => ({ ...candidate, score }));
}

export interface SearchResult {
  candidates: SearchCandidate[];
  requestedMode: "hybrid" | "lexical" | "semantic";
  realizedMode: "hybrid" | "lexical" | "semantic";
  semanticFailure: string | null;
}

@Injectable()
export class SearchService {
  constructor(
    @Inject(SEARCH_BACKEND) private readonly backend: SearchBackend,
    @Inject(SEMANTIC_SEARCH_PROVIDER) private readonly semantic: SemanticSearchProvider,
  ) {}

  async execute(
    context: TenantContext,
    query: string,
    requestedMode: "hybrid" | "lexical" | "semantic" = "hybrid",
    filters: SearchFilters = {},
    limit = 30,
  ): Promise<SearchResult> {
    const lexicalPromise = this.backend.lexical(context, query, filters, limit);
    if (requestedMode === "lexical") return { candidates: await lexicalPromise, requestedMode, realizedMode: "lexical", semanticFailure: null };
    try {
      const semantic = await this.semantic.search(context, query, filters, limit);
      if (requestedMode === "semantic") return { candidates: semantic, requestedMode, realizedMode: "semantic", semanticFailure: null };
      const lexical = await lexicalPromise;
      return { candidates: fuse(lexical, semantic).slice(0, limit), requestedMode, realizedMode: "hybrid", semanticFailure: null };
    } catch (error) {
      return {
        candidates: await lexicalPromise,
        requestedMode,
        realizedMode: "lexical",
        semanticFailure: error instanceof Error ? error.message : "semantic_provider_failed",
      };
    }
  }

  async response(context: TenantContext, query: string, mode: "hybrid" | "lexical" | "semantic", filters: SearchFilters, limit: number): Promise<Record<string, unknown>> {
    const started = performance.now();
    return searchResponseBody(await this.execute(context, query, mode, filters, limit), started);
  }
}

/**
 * One response shape for every search route. The team fan-out returns the same
 * body as `/search` — same items, same aggregations, same meta — so a client
 * renders one result list and not two, and so a field added here cannot appear
 * on one route and be forgotten on the other.
 */
export function searchResponseBody(result: SearchResult, startedAt: number): Record<string, unknown> {
  const agents: Record<string, number> = {};
  const workspaces: Record<string, number> = {};
  for (const candidate of result.candidates) {
    agents[candidate.session.source.tool] = (agents[candidate.session.source.tool] ?? 0) + 1;
    workspaces[candidate.session.workspace.path] = (workspaces[candidate.session.workspace.path] ?? 0) + 1;
  }
  return {
    items: result.candidates.map((candidate) => ({ ...sessionSummary(candidate.session), score: candidate.score, highlight: candidate.highlight })),
    nextCursor: null,
    aggregations: { agents, workspaces },
    meta: {
      requestedMode: result.requestedMode,
      realizedMode: result.realizedMode,
      tookMs: Math.max(0, Math.round(performance.now() - startedAt)),
      semanticFailure: result.semanticFailure,
    },
  };
}

export interface PackRequest {
  query: string;
  maxTokens: number;
  maxEvidence: number;
  maxSessions: number;
  maxExcerptChars: number;
  freshnessPolicy: "strict" | "mixed";
  staleAfterDays?: number;
}

export interface PackEvidence {
  sessionId: string;
  turnStart: number;
  turnEnd: number;
  ageDays: number;
  excerpt: string;
}

@Injectable()
export class PackService {
  constructor(private readonly search: SearchService, @Optional() private readonly clock: () => Date = () => new Date()) {}

  async build(context: TenantContext, request: PackRequest): Promise<Record<string, unknown>> {
    const result = await this.search.execute(context, request.query, "hybrid", {}, Math.max(request.maxEvidence, request.maxSessions));
    const now = this.clock().valueOf();
    const staleAfterDays = request.staleAfterDays ?? 90;
    const maximumCharacters = request.maxTokens * 4;
    const prefix = `# Memoar evidence\n\nQuery: ${request.query}\n`;
    let remaining = Math.max(0, maximumCharacters - prefix.length);
    const evidence: PackEvidence[] = [];
    const selectedSessions = new Set<string>();
    let staleCount = 0;
    const redactions = new Set<RedactionStatus>();
    const sections: string[] = [];
    for (const candidate of result.candidates) {
      if (evidence.length >= request.maxEvidence || selectedSessions.size >= request.maxSessions) break;
      const ageDays = Math.max(0, Math.floor((now - new Date(candidate.session.updatedAt).valueOf()) / 86_400_000));
      const stale = ageDays > staleAfterDays;
      if (stale && request.freshnessPolicy === "strict") continue;
      const textualTurns = candidate.session.turns.map((turn) => ({
        ordinal: turn.ordinal,
        text: turn.blocks.map((block) => block.text ?? "").filter(Boolean).join("\n"),
      })).filter((turn) => turn.text.length > 0);
      if (!textualTurns.length) continue;
      const turnStart = textualTurns[0]!.ordinal;
      const turnEnd = textualTurns.at(-1)!.ordinal;
      const heading = `\n## [${evidence.length + 1}] ${candidate.session.id} turns ${turnStart}-${turnEnd} age ${ageDays}d\n`;
      const fullExcerpt = textualTurns.map((turn) => `[turn ${turn.ordinal}] ${turn.text}`).join("\n");
      const availableExcerpt = Math.min(request.maxExcerptChars, Math.max(0, remaining - heading.length - 1));
      if (availableExcerpt < 1) break;
      const excerpt = fullExcerpt.slice(0, availableExcerpt);
      const section = `${heading}${excerpt}\n`;
      if (section.length > remaining) break;
      remaining -= section.length;
      sections.push(section);
      evidence.push({ sessionId: candidate.session.id, turnStart, turnEnd, ageDays, excerpt });
      selectedSessions.add(candidate.session.id);
      if (stale) staleCount += 1;
      redactions.add(candidate.session.redactionStatus);
    }
    const markdown = `${prefix}${sections.join("")}`.slice(0, maximumCharacters);
    const redactionStatus = redactions.has("findings")
      ? redactions.size > 1 ? "mixed" : "findings"
      : "clear";
    return {
      query: request.query,
      markdown,
      evidence,
      tokenEstimate: Math.ceil(markdown.length / 4),
      staleCount,
      redactionStatus,
    };
  }
}

@Controller()
export class SearchController {
  constructor(private readonly search: SearchService, private readonly packs: PackService) {}

  @Get("search")
  searchSessions(@Tenant() context: TenantContext, @Query() query: SearchQueryDto): Promise<Record<string, unknown>> {
    return this.search.response(context, query.q ?? "", query.mode ?? "hybrid", {
      ...(query.agent ? { agent: query.agent } : {}),
      ...(query.workspace ? { workspace: query.workspace } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
    }, query.limit ?? 30);
  }

  // Nest defaults POST to 201, but the contract documents 200: a pack is a
  // computed projection over existing sessions, not a created resource.
  @Post("pack")
  @HttpCode(200)
  pack(@Tenant() context: TenantContext, @Body() body: BuildPackDto): Promise<Record<string, unknown>> {
    return this.packs.build(context, body);
  }
}
