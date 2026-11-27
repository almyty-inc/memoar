import { DataSource } from "typeorm";
import type { ArchivedSession, SessionHeader, SessionStore, TenantContext } from "../archive-store.js";
import { isTeamVisible, teamVisibilitySql } from "../store/team-visibility.js";


export interface SearchCandidate {
  session: ArchivedSession | SessionHeader;
  score: number;
  highlight: string;
}

export interface SearchFilters {
  agent?: string;
  workspace?: string;
  from?: Date;
  to?: Date;
  /**
   * Set only by the team fan-out, which runs this query once inside each member
   * tenant. Present, it confines results to sessions actually widened to that
   * team — the one clause standing between a teammate and a member's private
   * archive, since RLS is satisfied for every row of the tenant being searched.
   */
  teamId?: string;
}

export interface SearchBackend {
  lexical(context: TenantContext, query: string, filters: SearchFilters, limit: number): Promise<SearchCandidate[]>;
  /** Whole sessions, turns included, for a caller that quotes them. */
  sessions(context: TenantContext, sessionIds: readonly string[]): Promise<ArchivedSession[]>;
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

  sessions(context: TenantContext, sessionIds: readonly string[]): Promise<ArchivedSession[]> {
    return this.store.getSessions(context, sessionIds);
  }

  async lexical(context: TenantContext, query: string, filters: SearchFilters, limit: number): Promise<SearchCandidate[]> {
    const page = await this.store.listSessions(context, {
      limit: 100,
      ...(filters.agent ? { agent: filters.agent } : {}),
      ...(filters.workspace ? { workspace: filters.workspace } : {}),
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
    });
    const terms = [...new Set(words(query))].sort();
    const teamId = filters.teamId;
    const visible = teamId ? page.items.filter((session) => isTeamVisible(session.visibility, teamId)) : page.items;
    return visible.map((session) => {
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
/**
 * How much of a search document the excerpt reads, starting a little before
 * the first literal hit. ts_headline parses all the text it is given, and a
 * long session's document runs to almost a megabyte: on dev, excerpts from
 * whole documents took 1.4 s of a 1.45 s query.
 */
const EXCERPT_WINDOW = 20_000;
const EXCERPT_LEAD = 2_000;

export class PostgresFtsBackend implements SearchBackend {
  constructor(private readonly dataSource: DataSource, private readonly store: SessionStore) {}

  sessions(context: TenantContext, sessionIds: readonly string[]): Promise<ArchivedSession[]> {
    return this.store.getSessions(context, sessionIds);
  }

  async lexical(context: TenantContext, query: string, filters: SearchFilters, limit: number): Promise<SearchCandidate[]> {
    const rows = await this.dataSource.transaction(async (manager): Promise<{ id: string; score: string; highlight: string }[]> => {
      await manager.query("SELECT set_config('memoar.tenant_id', $1, true)", [context.tenantId]);
      const values: unknown[] = [context.tenantId, query];
      const conditions = ["\"tenantId\" = $1", "(\"searchVector\" @@ websearch_to_tsquery('english', $2) OR title % $2)"];
      if (filters.agent) { values.push(filters.agent); conditions.push(`source ->> 'tool' = $${values.length}`); }
      if (filters.workspace) { values.push(`%${filters.workspace}%`); conditions.push(`workspace ->> 'path' ILIKE $${values.length}`); }
      if (filters.from) { values.push(filters.from); conditions.push(`\"capturedUpdatedAt\" >= $${values.length}`); }
      if (filters.to) { values.push(filters.to); conditions.push(`\"capturedUpdatedAt\" <= $${values.length}`); }
      if (filters.teamId) { values.push(filters.teamId); conditions.push(teamVisibilitySql(values.length)); }
      // ts_headline emits <b> markers by default. The client renders excerpts
      // as text and does its own <mark> highlighting, so markup here would show
      // up literally as "<b>parent</b>" on screen. Empty selectors keep the
      // excerpt plain and keep highlighting a client-side concern.
      // Two stage on purpose. A broad query matches tens of thousands of rows,
      // and scoring every one with similarity() and ts_headline() before the
      // top-N sort dominated the request. Stage one ranks with the indexed
      // tsvector alone and keeps a bounded candidate slice; stage two pays for
      // the expensive per-row work only on that slice.
      values.push(Math.max(limit * CANDIDATE_FACTOR, MINIMUM_CANDIDATES));
      const candidateLimitIndex = values.length;
      values.push(limit);
      const pageLimitIndex = values.length;
      // The literal words find where the excerpt window starts. A stemmed hit
      // with no literal match ("migrating" for "migration") falls back to the
      // start of the document, which is where ts_headline would look first.
      values.push([...new Set(words(query))]);
      const raw: unknown = await manager.query(`
        WITH candidates AS (
          SELECT id, title, "capturedUpdatedAt",
            ts_rank_cd("searchVector", websearch_to_tsquery('english', $2)) AS rank
          FROM sessions
          WHERE ${conditions.join(" AND ")}
          ORDER BY rank DESC, "capturedUpdatedAt" DESC, id ASC
          LIMIT $${candidateLimitIndex}
        ), page AS (
          SELECT id, "capturedUpdatedAt", rank + similarity(title, $2) AS score
          FROM candidates
          ORDER BY score DESC, "capturedUpdatedAt" DESC, id ASC
          LIMIT $${pageLimitIndex}
        )
        SELECT page.id, page.score,
          ts_headline('english', substr(s."searchDocument", greatest(1, coalesce(hit.at, 1) - ${EXCERPT_LEAD}), ${EXCERPT_WINDOW}),
            websearch_to_tsquery('english', $2), 'MaxWords=36, MinWords=12, StartSel="", StopSel=""') AS highlight
        FROM page
        JOIN sessions s ON s.id = page.id AND s."tenantId" = $1
        CROSS JOIN LATERAL (
          SELECT min(nullif(strpos(lower(s."searchDocument"), term), 0)) AS at FROM unnest($${values.length}::text[]) AS term
        ) hit
        ORDER BY page.score DESC, page."capturedUpdatedAt" DESC, page.id ASC
      `, values);
      return raw as { id: string; score: string; highlight: string }[];
    });
    // List rows only: the excerpt came from the search document, so the turns
    // of every hit would be loaded just to be counted.
    const hydrated = await this.store.getSessionHeaders(context, rows.map((row) => row.id));
    const sessions = new Map(hydrated.map((session) => [session.id, session]));
    const candidates: SearchCandidate[] = [];
    for (const row of rows) {
      const session = sessions.get(row.id);
      if (session) candidates.push({ session, score: Number(row.score), highlight: row.highlight });
    }
    return candidates;
  }
}
