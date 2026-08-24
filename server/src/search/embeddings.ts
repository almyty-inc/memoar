import { DataSource } from "typeorm";
import type { SessionStore, TenantContext } from "../archive-store.js";
import { excerptAround, sessionText, words, type SearchCandidate, type SearchFilters } from "./backends.js";

export interface SemanticSearchProvider {
  search(context: TenantContext, query: string, filters: SearchFilters, limit: number): Promise<SearchCandidate[]>;
}

export class DisabledSemanticSearchProvider implements SemanticSearchProvider {
  search(): Promise<SearchCandidate[]> { return Promise.reject(new Error("semantic_provider_unavailable")); }
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<readonly number[]>;
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly model: string,
    readonly dimensions: number,
  ) {}

  async embed(text: string): Promise<readonly number[]> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: text.slice(0, 8000), dimensions: this.dimensions }),
    });
    if (!response.ok) throw new Error(`embedding_provider_http_${response.status}`);
    const payload = await response.json() as { data?: { embedding?: number[] }[] };
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== this.dimensions) throw new Error("embedding_provider_bad_response");
    return vector;
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimensions = 768) {}

  embed(text: string): Promise<readonly number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? [];
    for (const [index, token] of tokens.entries()) {
      const previous = index > 0 ? tokens[index - 1] : null;
      for (const gram of previous === null ? [token] : [token, `${previous} ${token}`]) {
        const hash = fnv1a(gram);
        const slot = hash % this.dimensions;
        vector[slot] = (vector[slot] ?? 0) + ((hash & 0x10000) === 0 ? 1 : -1);
      }
    }
    let squares = 0;
    for (const component of vector) squares += component * component;
    const norm = Math.sqrt(squares);
    return Promise.resolve(norm > 0 ? vector.map((component) => component / norm) : vector);
  }
}

export function embeddingProviderFromEnv(env: Record<string, string | undefined> = process.env): EmbeddingProvider | null {
  const kind = env.MEMOAR_EMBEDDINGS_PROVIDER ?? "disabled";
  const dimensions = Number(env.MEMOAR_EMBEDDINGS_DIMENSIONS ?? 768);
  if (kind === "deterministic") return new DeterministicEmbeddingProvider(dimensions);
  if (kind === "openai") {
    const apiKey = env.MEMOAR_EMBEDDINGS_API_KEY;
    if (!apiKey) throw new Error("MEMOAR_EMBEDDINGS_API_KEY is required when MEMOAR_EMBEDDINGS_PROVIDER=openai");
    return new HttpEmbeddingProvider(
      env.MEMOAR_EMBEDDINGS_URL ?? "https://api.openai.com/v1/embeddings",
      apiKey,
      env.MEMOAR_EMBEDDINGS_MODEL ?? "text-embedding-3-small",
      dimensions,
    );
  }
  if (kind === "disabled") return null;
  throw new Error(`Unknown MEMOAR_EMBEDDINGS_PROVIDER: ${kind}`);
}

export class PostgresVectorSearchProvider implements SemanticSearchProvider {
  constructor(
    private readonly dataSource: DataSource,
    private readonly store: SessionStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async search(context: TenantContext, query: string, filters: SearchFilters, limit: number): Promise<SearchCandidate[]> {
    const vector = await this.embeddings.embed(query);
    if (vector.length !== this.embeddings.dimensions) throw new Error("embedding_dimension_mismatch");
    const rows = await this.dataSource.transaction(async (manager): Promise<{ id: string; score: string }[]> => {
      await manager.query("SELECT set_config('memoar.tenant_id', $1, true)", [context.tenantId]);
      const values: unknown[] = [context.tenantId, `[${vector.join(",")}]`];
      const conditions = ["\"tenantId\" = $1", "embedding IS NOT NULL"];
      if (filters.agent) { values.push(filters.agent); conditions.push(`source ->> 'tool' = $${values.length}`); }
      if (filters.workspace) { values.push(`%${filters.workspace}%`); conditions.push(`workspace ->> 'path' ILIKE $${values.length}`); }
      if (filters.from) { values.push(filters.from); conditions.push(`"capturedUpdatedAt" >= $${values.length}`); }
      if (filters.to) { values.push(filters.to); conditions.push(`"capturedUpdatedAt" <= $${values.length}`); }
      values.push(limit);
      // ORDER BY must be the distance alone: an HNSW index can only satisfy a
      // single distance ordering, and appending a tiebreaker made Postgres sort
      // every candidate row instead, turning a 1ms index scan into a ~215ms
      // full scan. Ties are broken by id below, over the bounded result set.
      const raw: unknown = await manager.query(`
        SELECT id, 1 - (embedding <=> $2::vector) AS score
        FROM sessions
        WHERE ${conditions.join(" AND ")}
        ORDER BY embedding <=> $2::vector
        LIMIT $${values.length}
      `, values);
      return (raw as { id: string; score: string }[])
        .sort((left, right) => Number(right.score) - Number(left.score) || left.id.localeCompare(right.id));
    });
    // One batched hydration instead of a query trio per result.
    const hydrated = await this.store.getSessions(context, rows.map((row) => row.id));
    const sessions = new Map(hydrated.map((session) => [session.id, session]));
    const candidates: SearchCandidate[] = [];
    for (const row of rows) {
      const session = sessions.get(row.id);
      if (session) candidates.push({ session, score: Number(row.score), highlight: excerptAround(sessionText(session), words(query)) });
    }
    return candidates;
  }
}
