import type { EntityManager } from "typeorm";
import { SessionEntity, type SessionRow } from "../../entities.js";
import type { SessionFacetCounts, SessionFilter, SessionHeader, TenantContext } from "../context.js";
import { sessionFields } from "./assemble.js";
import { decodeCursor, encodeCursor, TenantScope } from "./runner.js";

export interface SessionRowPage {
  rows: SessionRow[];
  total: number;
  nextCursor: string | null;
}

/** One page of session rows in list order, with the total the filter matches. */
export async function sessionRowPage(manager: EntityManager, context: TenantContext, filter: SessionFilter): Promise<SessionRowPage> {
  const query = TenantScope.apply(manager.getRepository(SessionEntity).createQueryBuilder("session"), "session", context)
    .orderBy("session.capturedUpdatedAt", "DESC")
    .addOrderBy("session.id", "DESC");
  if (filter.agent) query.andWhere("session.source ->> 'tool' = :agent", { agent: filter.agent });
  if (filter.workspace) query.andWhere("session.workspace ->> 'path' ILIKE :workspace", { workspace: `%${filter.workspace}%` });
  if (filter.machineId) query.andWhere("session.source ->> 'machineId' = :machineId", { machineId: filter.machineId });
  if (filter.model) query.andWhere(":model = ANY(session.models)", { model: filter.model });
  if (filter.from) query.andWhere("session.capturedUpdatedAt >= :from", { from: filter.from });
  if (filter.to) query.andWhere("session.capturedUpdatedAt <= :to", { to: filter.to });
  // How many match the filter, before the cursor narrows it to one page.
  // Without this the client can say how many sessions it is holding but not
  // how many there are, which is the number a reader actually wants.
  const total = await query.getCount();

  if (filter.cursor) {
    const cursor = decodeCursor(filter.cursor);
    if (cursor) query.andWhere("(session.capturedUpdatedAt, session.id) < (:cursorDate, :cursorId)", {
      cursorDate: cursor.updatedAt,
      cursorId: cursor.id,
    });
  }
  const rows = await query.take(filter.limit + 1).getMany();
  const hasNext = rows.length > filter.limit;
  const pageRows = rows.slice(0, filter.limit);
  const last = pageRows.at(-1);
  return { rows: pageRows, total, nextCursor: hasNext && last ? encodeCursor(last.capturedUpdatedAt, last.id) : null };
}

/** Every agent and project the tenant has sessions from: two grouped counts. */
export async function sessionFacets(manager: EntityManager, context: TenantContext): Promise<SessionFacetCounts> {
  const [sources, workspaces] = await Promise.all([
    manager.query<{ source: string; sessions: number }[]>(
      `SELECT source->>'tool' AS source, count(*)::int AS sessions
         FROM sessions WHERE "tenantId" = $1
        GROUP BY 1 ORDER BY 2 DESC, 1`,
      [context.tenantId],
    ),
    manager.query<{ path: string; sessions: number; last: Date }[]>(
      `SELECT workspace->>'path' AS path, count(*)::int AS sessions, max("capturedUpdatedAt") AS last
         FROM sessions WHERE "tenantId" = $1
        GROUP BY 1 ORDER BY 3 DESC, 1`,
      [context.tenantId],
    ),
  ]);
  return {
    sources,
    workspaces: workspaces.map((row) => ({ path: row.path, sessions: row.sessions, lastUpdatedAt: new Date(row.last).toISOString() })),
  };
}

interface TurnStats {
  sessionId: string;
  turns: number;
  first: Date | null;
  last: Date | null;
}

/** The list rows for a page: one grouped query over turns, no blocks at all. */
export async function sessionHeaders(manager: EntityManager, context: TenantContext, rows: readonly SessionRow[]): Promise<SessionHeader[]> {
  if (rows.length === 0) return [];
  const stats: TurnStats[] = await manager.query(
    `SELECT "sessionId", count(*)::int AS turns, min("capturedAt") AS first, max("capturedAt") AS last
       FROM turns WHERE "tenantId" = $1 AND "sessionId" = ANY($2::uuid[])
      GROUP BY "sessionId"`,
    [context.tenantId, rows.map((row) => row.id)],
  );
  const bySession = new Map(stats.map((stat) => [stat.sessionId, stat]));
  return rows.map((row) => {
    const stat = bySession.get(row.id);
    return {
      ...sessionFields(row),
      turnCount: stat?.turns ?? 0,
      firstTurnAt: stat?.first ? new Date(stat.first).toISOString() : null,
      lastTurnAt: stat?.last ? new Date(stat.last).toISOString() : null,
    };
  });
}
