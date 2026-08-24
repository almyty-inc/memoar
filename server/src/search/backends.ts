import { DataSource } from "typeorm";
import type { ArchivedSession, SessionStore, TenantContext } from "../archive-store.js";


export interface SearchCandidate {
  session: ArchivedSession;
  score: number;
  highlight: string;
}

export interface SearchFilters {
  agent?: string;
  workspace?: string;
  from?: Date;
  to?: Date;
}

export interface SearchBackend {
  lexical(context: TenantContext, query: string, filters: SearchFilters, limit: number): Promise<SearchCandidate[]>;
}

export function words(value: string): string[] {
  return value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

export function sessionText(session: ArchivedSession): string {
  return [session.title, session.summary ?? "", ...session.turns.flatMap((turn) => turn.blocks.map((block) => block.text ?? ""))].join("\n");
}

export function excerptAround(text: string, queryWords: readonly string[], maximum = 240): string {
  const lower = text.toLocaleLowerCase("en-US");
  const positions = queryWords.map((word) => lower.indexOf(word)).filter((position) => position >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, first - Math.floor(maximum / 3));
  return text.slice(start, start + maximum).replace(/\s+/gu, " ").trim();
}

export class DeterministicLexicalBackend implements SearchBackend {
  constructor(private readonly store: SessionStore) {}

  async lexical(context: TenantContext, query: string, filters: SearchFilters, limit: number): Promise<SearchCandidate[]> {
    const page = await this.store.listSessions(context, {
      limit: 100,
      ...(filters.agent ? { agent: filters.agent } : {}),
      ...(filters.workspace ? { workspace: filters.workspace } : {}),
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
    });
    const terms = [...new Set(words(query))].sort();
    return page.items.map((session) => {
      const text = sessionText(session);
      const documentWords = words(text);
      const frequencies = new Map<string, number>();
      for (const word of documentWords) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
      const matched = terms.reduce((sum, term) => sum + (frequencies.get(term) ?? 0), 0);
      const coverage = terms.length ? terms.filter((term) => frequencies.has(term)).length / terms.length : 0;
      return { session, score: matched + coverage, highlight: excerptAround(text, terms) };
    }).filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || right.session.updatedAt.localeCompare(left.session.updatedAt) || left.session.id.localeCompare(right.session.id))
      .slice(0, limit);
  }
}

/** How many ranked candidates to rescore before returning the requested page. */
const CANDIDATE_FACTOR = 8;
const MINIMUM_CANDIDATES = 200;

export class PostgresFtsBackend implements SearchBackend {
  constructor(private readonly dataSource: DataSource, private readonly store: SessionStore) {}

  async lexical(context: TenantContext, query: string, filters: SearchFilters, limit: number): Promise<SearchCandidate[]> {
    const rows = await this.dataSource.transaction(async (manager): Promise<{ id: string; score: string; highlight: string }[]> => {
      await manager.query("SELECT set_config('memoar.tenant_id', $1, true)", [context.tenantId]);
      const values: unknown[] = [context.tenantId, query];
      const conditions = ["\"tenantId\" = $1", "(\"searchVector\" @@ websearch_to_tsquery('english', $2) OR title % $2)"];
      if (filters.agent) { values.push(filters.agent); conditions.push(`source ->> 'tool' = $${values.length}`); }
      if (filters.workspace) { values.push(`%${filters.workspace}%`); conditions.push(`workspace ->> 'path' ILIKE $${values.length}`); }
      if (filters.from) { values.push(filters.from); conditions.push(`\"capturedUpdatedAt\" >= $${values.length}`); }
      if (filters.to) { values.push(filters.to); conditions.push(`\"capturedUpdatedAt\" <= $${values.length}`); }
      // Two stage on purpose. A broad query matches tens of thousands of rows,
      // and scoring every one with similarity() and ts_headline() before the
      // top-N sort dominated the request. Stage one ranks with the indexed
      // tsvector alone and keeps a bounded candidate slice; stage two pays for
      // the expensive per-row work only on that slice.
      values.push(Math.max(limit * CANDIDATE_FACTOR, MINIMUM_CANDIDATES));
      const candidateLimitIndex = values.length;
      values.push(limit);
      const raw: unknown = await manager.query(`
        WITH candidates AS (
          SELECT id, title, "searchDocument", "capturedUpdatedAt",
            ts_rank_cd("searchVector", websearch_to_tsquery('english', $2)) AS rank
          FROM sessions
          WHERE ${conditions.join(" AND ")}
          ORDER BY rank DESC, "capturedUpdatedAt" DESC, id ASC
          LIMIT $${candidateLimitIndex}
        )
        SELECT id,
          rank + similarity(title, $2) AS score,
          ts_headline('english', "searchDocument", websearch_to_tsquery('english', $2), 'MaxWords=36, MinWords=12') AS highlight
        FROM candidates
        ORDER BY score DESC, "capturedUpdatedAt" DESC, id ASC
        LIMIT $${values.length}
      `, values);
      return raw as { id: string; score: string; highlight: string }[];
    });
    // One batched hydration instead of a query trio per result.
    const hydrated = await this.store.getSessions(context, rows.map((row) => row.id));
    const sessions = new Map(hydrated.map((session) => [session.id, session]));
    const candidates: SearchCandidate[] = [];
    for (const row of rows) {
      const session = sessions.get(row.id);
      if (session) candidates.push({ session, score: Number(row.score), highlight: row.highlight });
    }
    return candidates;
  }
}
