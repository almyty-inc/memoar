import { In, type EntityManager } from "typeorm";
import type { Visibility } from "../../../libs/canonical/src/generated.js";
import { ContentBlockEntity, SessionEntity, SessionIdentityEntity, TurnEntity } from "../../entities.js";
import { uuidV7 } from "../../ids.js";
import type { ArchivedSession, SessionFilter, SessionPage, TenantContext } from "../context.js";
import type { SessionParse, SessionStore } from "../interfaces.js";
import { firstUnheld, proposalList } from "../identity-proposal.js";
import { withoutNulBytes } from "../nul-bytes.js";
import { scopeCollidingIds, separateRepeatedIds } from "../turn-identity.js";
import { assembleSession } from "./assemble.js";
import { rowIdsHeldElsewhere, rowIdsStoredHere } from "./row-ids.js";
import { boundedSearchDocument } from "./search-document.js";
import { insertSessionRows } from "./session-rows.js";
import { decodeCursor, encodeCursor, TenantRunner, TenantScope } from "./runner.js";

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly runner: TenantRunner) {}

  /**
   * Replaces a session and everything under it, one saver at a time.
   *
   * Two uploads resolving to one canonical session id is the design — the agent
   * re-sends a growing transcript as a new sha on every append — so with four
   * workers, concurrent saves of one session happen by construction. They
   * deadlocked, and the report names the cycle:
   *
   *   Process 87 waits for ShareLock on transaction 743; blocked by process 85.
   *   Process 85 waits for ShareLock on transaction 740; blocked by process 87.
   *   Process 87: UPDATE "content_blocks" SET "text" = $1 WHERE "id" = $2
   *   Process 85: UPDATE "sessions" SET "title" = $1, ... WHERE "id" = $4
   *
   * The two rows are the session and one of its blocks, taken in opposite
   * orders. A saver whose DELETE found the rows takes the block first and the
   * session row after; a saver that arrived while the first held them deletes
   * nothing, reaches the session row first, and then finds the blocks already
   * there — so `save()` turns into the UPDATE above, behind the session row it
   * is already holding. Same code, inverted order, cycle.
   *
   * The lock is on the session id, because that is the granularity the cycle
   * lives at, and it is transaction-scoped, so it is released by the commit or
   * the rollback and never outlives either. It also removes the wasted half of
   * the race: the loser no longer rewrites rows the winner just wrote.
   */
  async saveSession(context: TenantContext, captured: ArchivedSession): Promise<void> {
    // Once, before anything reads it, so every column below — and the search
    // document derived from the blocks — gets the cleaned text.
    const cleaned = withoutNulBytes(captured);
    await this.runner.inTenant(context, async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [context.tenantId, cleaned.id]);
      const sessionRepository = manager.getRepository(SessionEntity);
      const turnRepository = manager.getRepository(TurnEntity);
      const blockRepository = manager.getRepository(ContentBlockEntity);
      // Which of these turn and block ids a row outside this session already
      // holds, in any account, and which this session already stores in their
      // rescoped form. Asked inside the lock, so the answer is the one the
      // inserts below will meet. See `scopeCollidingIds` for why a shared id is
      // rescoped rather than refused, and `rowIdsHeldElsewhere` for why the
      // lookup cannot be an ordinary query.
      const elsewhere = await rowIdsHeldElsewhere(manager, context.tenantId, cleaned);
      const here = await rowIdsStoredHere(manager, context.tenantId, cleaned.id);
      const session = separateRepeatedIds(scopeCollidingIds(cleaned, elsewhere, here));
      await blockRepository.delete({ tenantId: context.tenantId, sessionId: session.id });
      await turnRepository.delete({ tenantId: context.tenantId, sessionId: session.id });
      const searchDocument = boundedSearchDocument(session);
      await sessionRepository.save(sessionRepository.create({
        id: session.id,
        tenantId: context.tenantId,
        source: session.source,
        workspace: session.workspace,
        capturedCreatedAt: new Date(session.createdAt),
        capturedUpdatedAt: new Date(session.updatedAt),
        title: session.title,
        summary: session.summary ?? null,
        models: session.models,
        tokenTotals: session.tokenTotals,
        provenance: session.provenance,
        visibility: session.visibility,
        redactionStatus: session.redactionStatus,
        searchDocument,
        embedding: null,
        ext: session.ext ?? null,
      }));
      await insertSessionRows(manager, context.tenantId, session);
    });
  }

  async resolveSessionIdentity(
    context: TenantContext,
    identity: { sourceTool: string; sourceVersion: string; nativeSessionId: string },
    proposedSessionIds: string | readonly string[],
  ): Promise<string> {
    return this.runner.inTenant(context, async (manager) => {
      const repository = manager.getRepository(SessionIdentityEntity);
      const lookup = {
        tenantId: context.tenantId,
        sourceTool: identity.sourceTool,
        nativeSessionId: identity.nativeSessionId,
      };
      const existing = await repository.findOneBy(lookup);
      if (existing) {
        if (existing.sourceVersion !== identity.sourceVersion) {
          await repository.update({ id: existing.id }, { sourceVersion: identity.sourceVersion });
        }
        return existing.sessionId;
      }
      // See `firstUnheld`: a proposal another identity holds would merge two
      // conversations into one session.
      const held = await repository.findBy({ tenantId: context.tenantId, sessionId: In([...proposalList(proposedSessionIds)]) });
      const chosen = firstUnheld(proposedSessionIds, new Set(held.map((row) => row.sessionId)));
      await repository
        .createQueryBuilder()
        .insert()
        .values({
          id: uuidV7(),
          ...lookup,
          sourceVersion: identity.sourceVersion,
          sessionId: chosen,
        })
        .orIgnore()
        .execute();
      const resolved = await repository.findOneBy(lookup);
      return resolved?.sessionId ?? chosen;
    });
  }

  async saveSessionEmbedding(context: TenantContext, sessionId: string, vector: readonly number[]): Promise<void> {
    await this.runner.inTenant(context, async (manager) => {
      await manager.query(
        `UPDATE sessions SET embedding = $3::vector WHERE "tenantId" = $1 AND id = $2`,
        [context.tenantId, sessionId, `[${vector.join(",")}]`],
      );
    });
  }

  async updateSessionVisibility(context: TenantContext, sessionId: string, visibility: Visibility): Promise<boolean> {
    return this.runner.inTenant(context, async (manager) => {
      const result = await manager.getRepository(SessionEntity).update({ tenantId: context.tenantId, id: sessionId }, { visibility });
      return (result.affected ?? 0) > 0;
    });
  }

  async listSessions(context: TenantContext, filter: SessionFilter): Promise<SessionPage> {
    return this.runner.inTenant(context, async (manager) => {
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
      // Hydrated together: three queries for the page, not three per session.
      const items = await this.hydrateWithManager(manager, context, pageRows.map((row) => row.id));
      const last = pageRows.at(-1);
      return { items, total, nextCursor: hasNext && last ? encodeCursor(last.capturedUpdatedAt, last.id) : null };
    });
  }

  async getSession(context: TenantContext, sessionId: string): Promise<ArchivedSession | null> {
    return this.runner.inTenant(context, (manager) => this.getSessionWithManager(manager, context, sessionId));
  }

  /** Read off the session rows' own columns, never their turns. */
  async sessionParserVersions(context: TenantContext): Promise<Map<string, SessionParse>> {
    return this.runner.inTenant(context, async (manager) => {
      const rows: { id: string; machineId: string | null; parserVersion: string | null }[] = await manager.query(
        `SELECT id, source->>'machineId' AS "machineId",
                (SELECT entry->>'parserVersion' FROM jsonb_array_elements(provenance) entry
                  WHERE entry->>'kind' = 'native' LIMIT 1) AS "parserVersion"
           FROM sessions WHERE "tenantId" = $1`,
        [context.tenantId],
      );
      return new Map(rows.map((row) => [row.id, { parserVersion: row.parserVersion, machineId: row.machineId }]));
    });
  }

  /** One grouped count for the whole account, not one query per source. */
  async countSessionsByMachineSource(context: TenantContext): Promise<{ machineId: string; tool: string; sessions: number }[]> {
    return this.runner.inTenant(context, async (manager) => {
      return manager.query(
        `SELECT source->>'machineId' AS "machineId", source->>'tool' AS tool, count(*)::int AS sessions
           FROM sessions
          WHERE "tenantId" = $1 AND source->>'machineId' IS NOT NULL
          GROUP BY 1, 2`,
        [context.tenantId],
      );
    });
  }

  /** One indexed count, rather than hydrating every turn to answer yes or no. */
  async sessionExists(context: TenantContext, sessionId: string): Promise<boolean> {
    return this.runner.inTenant(context, async (manager) =>
      await manager.getRepository(SessionEntity).countBy({ id: sessionId, tenantId: context.tenantId }) > 0);
  }

  /**
   * Hydrates many sessions with three queries instead of three per session.
   */
  async getSessions(context: TenantContext, sessionIds: readonly string[]): Promise<ArchivedSession[]> {
    if (sessionIds.length === 0) return [];
    return this.runner.inTenant(context, (manager) => this.hydrateWithManager(manager, context, sessionIds));
  }

  /** The same batched hydration, for callers already inside a transaction. */
  async hydrateWithManager(
    manager: EntityManager,
    context: TenantContext,
    sessionIds: readonly string[],
  ): Promise<ArchivedSession[]> {
    if (sessionIds.length === 0) return [];
    {
      const ids = [...new Set(sessionIds)];
      const [sessions, turns, blocks] = await Promise.all([
        manager.getRepository(SessionEntity).find({ where: { tenantId: context.tenantId, id: In(ids) } }),
        manager.getRepository(TurnEntity).find({ where: { tenantId: context.tenantId, sessionId: In(ids) }, order: { ordinal: "ASC" } }),
        manager.getRepository(ContentBlockEntity).find({ where: { tenantId: context.tenantId, sessionId: In(ids) }, order: { ordinal: "ASC" } }),
      ]);
      const turnsBySession = new Map<string, typeof turns>();
      for (const turn of turns) {
        const list = turnsBySession.get(turn.sessionId) ?? [];
        list.push(turn);
        turnsBySession.set(turn.sessionId, list);
      }
      const blocksByTurn = new Map<string, typeof blocks>();
      for (const block of blocks) {
        const list = blocksByTurn.get(block.turnId) ?? [];
        list.push(block);
        blocksByTurn.set(block.turnId, list);
      }
      const bySessionId = new Map(sessions.map((session) => [
        session.id,
        assembleSession(session, turnsBySession.get(session.id) ?? [], blocksByTurn),
      ]));
      // Preserve the caller's ranking order and drop ids that no longer exist.
      return sessionIds.map((id) => bySessionId.get(id)).filter((session): session is ArchivedSession => session !== undefined);
    }
  }

  async getSessionWithManager(
    manager: EntityManager,
    context: TenantContext,
    sessionId: string,
  ): Promise<ArchivedSession | null> {
    const session = await manager.getRepository(SessionEntity).findOneBy({ id: sessionId, tenantId: context.tenantId });
    if (!session) return null;
    const turns = await manager.getRepository(TurnEntity).find({
      where: { tenantId: context.tenantId, sessionId },
      order: { ordinal: "ASC" },
    });
    const blocks = await manager.getRepository(ContentBlockEntity).find({
      where: { tenantId: context.tenantId, sessionId },
      order: { ordinal: "ASC" },
    });
    const blocksByTurn = new Map<string, typeof blocks>();
    for (const block of blocks) {
      const list = blocksByTurn.get(block.turnId) ?? [];
      list.push(block);
      blocksByTurn.set(block.turnId, list);
    }
    return assembleSession(session, turns, blocksByTurn);
  }

  async deleteSession(context: TenantContext, sessionId: string): Promise<boolean> {
    return this.runner.inTenant(context, async (manager) => {
      const result = await manager.getRepository(SessionEntity).delete({ id: sessionId, tenantId: context.tenantId });
      return (result.affected ?? 0) > 0;
    });
  }
}
