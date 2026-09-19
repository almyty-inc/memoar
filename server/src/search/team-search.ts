import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { TenantContext } from "../archive-store.js";
import { SEARCH_BACKEND, SEMANTIC_SEARCH_PROVIDER } from "../tokens.js";
import type { SearchBackend, SearchCandidate, SearchFilters } from "./backends.js";
import type { SemanticSearchProvider } from "./embeddings.js";
import { fuse, searchResponseBody, type SearchResult } from "./search.service.js";

/**
 * How many member tenants one team search may fan out over.
 *
 * The honest cost of not having a cross-tenant index: one round trip per member
 * tenant. The alternative — a policy that accepts a set of tenants so a single
 * query can span the team — is the design that leaks the moment one setting is
 * mis-set or one route builds the list from user input. So the cost is paid,
 * and capped: past this the request is refused rather than quietly slow.
 */
export const MAX_TEAM_SEARCH_TENANTS = 25;

/** Enough parallelism to hide latency, not enough to empty the pool. */
const FANOUT_CONCURRENCY = 4;

interface TenantLeg {
  lexical: SearchCandidate[];
  semantic: SearchCandidate[] | null;
  failure: string | null;
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Search across a team, one tenant at a time.
 *
 * Every leg is an ordinary single-tenant search: the same lexical and semantic
 * queries `/search` runs, inside their own transaction pinned to one tenant, so
 * row-level security is doing exactly what it does for a personal search. The
 * two things that make it a team search are the list of tenants it may iterate
 * — accepted members only — and the team visibility predicate every leg carries
 * (`SearchFilters.teamId`), which is what keeps a member's private sessions out
 * of their teammates' results.
 */
@Injectable()
export class TeamSearchService {
  constructor(
    @Inject(SEARCH_BACKEND) private readonly backend: SearchBackend,
    @Inject(SEMANTIC_SEARCH_PROVIDER) private readonly semantic: SemanticSearchProvider,
  ) {}

  /** A read context for one member's tenant. Read scope only; it writes nothing. */
  private static contextFor(tenantId: string): TenantContext {
    return { tenantId, userId: tenantId, scopes: ["archive:read"], authType: "machine" };
  }

  async execute(
    teamId: string,
    tenantIds: readonly string[],
    query: string,
    requestedMode: "hybrid" | "lexical" | "semantic",
    filters: SearchFilters,
    limit: number,
  ): Promise<SearchResult> {
    if (tenantIds.length > MAX_TEAM_SEARCH_TENANTS) {
      throw new BadRequestException(`Team search spans at most ${MAX_TEAM_SEARCH_TENANTS} member tenants`);
    }
    const scoped: SearchFilters = { ...filters, teamId };
    const legs = await mapWithConcurrency(tenantIds, FANOUT_CONCURRENCY, (tenantId) => this.leg(tenantId, query, requestedMode, scoped, limit));
    // Decided once for the whole request, not per tenant. A mix would rank some
    // members' sessions by hybrid fusion and others by lexical alone, and the
    // merged list would be two ranking regimes wearing one set of numbers.
    const failure = legs.find((leg) => leg.failure)?.failure ?? null;
    const lexicalOnly = requestedMode === "lexical" || failure !== null;
    const lists = lexicalOnly
      ? legs.map((leg) => leg.lexical)
      : requestedMode === "semantic"
        ? legs.map((leg) => leg.semantic ?? [])
        : legs.flatMap((leg) => [leg.lexical, leg.semantic ?? []]);
    return {
      candidates: fuse(...lists).slice(0, limit),
      requestedMode,
      realizedMode: lexicalOnly ? "lexical" : requestedMode,
      semanticFailure: failure,
    };
  }

  private async leg(
    tenantId: string,
    query: string,
    requestedMode: "hybrid" | "lexical" | "semantic",
    filters: SearchFilters,
    limit: number,
  ): Promise<TenantLeg> {
    const context = TeamSearchService.contextFor(tenantId);
    // Each tenant returns its own `limit` candidates: the merge needs something
    // to rank per member, so over-fetching here is the point. What is bounded is
    // summaries, not transcripts — hydration stays inside each leg.
    const lexical = await this.backend.lexical(context, query, filters, limit);
    if (requestedMode === "lexical") return { lexical, semantic: null, failure: null };
    try {
      return { lexical, semantic: await this.semantic.search(context, query, filters, limit), failure: null };
    } catch (error) {
      return { lexical, semantic: null, failure: error instanceof Error ? error.message : "semantic_provider_failed" };
    }
  }

  async response(
    teamId: string,
    tenantIds: readonly string[],
    query: string,
    mode: "hybrid" | "lexical" | "semantic",
    filters: SearchFilters,
    limit: number,
  ): Promise<Record<string, unknown>> {
    const started = performance.now();
    return searchResponseBody(await this.execute(teamId, tenantIds, query, mode, filters, limit), started);
  }
}
