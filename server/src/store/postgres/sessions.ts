import { In, type EntityManager } from "typeorm";
import type { Visibility } from "../../../libs/canonical/src/generated.js";
import { ContentBlockEntity, SessionEntity, SessionIdentityEntity, TurnEntity, type ContentBlockRow, type SessionRow, type TurnRow } from "../../entities.js";
import { uuidV7 } from "../../ids.js";
import type { ArchivedSession, SessionFilter, SessionPage, TenantContext } from "../context.js";
import type { SessionStore } from "../interfaces.js";
import { decodeCursor, encodeCursor, TenantRunner, TenantScope } from "./runner.js";

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly runner: TenantRunner) {}

  async saveSession(context: TenantContext, session: ArchivedSession): Promise<void> {
    await this.runner.inTenant(context, async (manager) => {
      const sessionRepository = manager.getRepository(SessionEntity);
      const turnRepository = manager.getRepository(TurnEntity);
      const blockRepository = manager.getRepository(ContentBlockEntity);
      await blockRepository.delete({ tenantId: context.tenantId, sessionId: session.id });
      await turnRepository.delete({ tenantId: context.tenantId, sessionId: session.id });
      const searchDocument = session.turns.flatMap((turn) => turn.blocks.map((block) => block.text ?? "")).join("\n");
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
      for (const turn of session.turns) {
        await turnRepository.save(turnRepository.create({
          id: turn.id,
          tenantId: context.tenantId,
          sessionId: session.id,
          ordinal: turn.ordinal,
          parentId: turn.parentId,
          role: turn.role,
          capturedAt: new Date(turn.createdAt),
          model: turn.model ?? null,
          tokens: turn.tokens ?? null,
          ext: turn.ext ?? null,
        }));
        const blocks = turn.blocks.map((block, ordinal) => blockRepository.create({
          id: block.id,
          tenantId: context.tenantId,
          sessionId: session.id,
          turnId: turn.id,
          ordinal,
          kind: block.kind,
          text: block.text ?? null,
          name: block.name ?? null,
          callId: block.callId ?? null,
          language: block.language ?? null,
          mimeType: block.mimeType ?? null,
          artifactRef: block.artifactRef ?? null,
          data: block.data ?? null,
          ext: block.ext ?? null,
        }));
        if (blocks.length) await blockRepository.save(blocks);
      }
    });
  }

  async resolveSessionIdentity(
    context: TenantContext,
    identity: { sourceTool: string; sourceVersion: string; nativeSessionId: string },
    proposedSessionId: string,
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
      await repository
        .createQueryBuilder()
        .insert()
        .values({
          id: uuidV7(),
          ...lookup,
          sourceVersion: identity.sourceVersion,
          sessionId: proposedSessionId,
        })
        .orIgnore()
        .execute();
      const resolved = await repository.findOneBy(lookup);
      return resolved?.sessionId ?? proposedSessionId;
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
      // Hydrated together. One page used to cost three queries per session, so
      // a fifty-session page was a hundred and fifty round trips for a list.
      const items = await this.hydrateWithManager(manager, context, pageRows.map((row) => row.id));
      const last = pageRows.at(-1);
      return { items, total, nextCursor: hasNext && last ? encodeCursor(last.capturedUpdatedAt, last.id) : null };
    });
  }

  async getSession(context: TenantContext, sessionId: string): Promise<ArchivedSession | null> {
    return this.runner.inTenant(context, (manager) => this.getSessionWithManager(manager, context, sessionId));
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
   * Search results used to be fetched one at a time, which put dozens of round
   * trips inside a single request.
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

/** Builds a canonical session from its already-loaded rows. */
function assembleSession(
  session: SessionRow,
  turns: readonly TurnRow[],
  blocksByTurn: ReadonlyMap<string, readonly ContentBlockRow[]>,
): ArchivedSession {
  return {
      id: session.id,
      source: session.source,
      workspace: session.workspace,
      createdAt: session.capturedCreatedAt.toISOString(),
      updatedAt: session.capturedUpdatedAt.toISOString(),
      title: session.title,
      ...(session.summary ? { summary: session.summary } : {}),
      models: session.models,
      tokenTotals: session.tokenTotals,
      provenance: session.provenance,
      visibility: session.visibility,
      turns: turns.map((turn) => ({
        id: turn.id,
        ordinal: turn.ordinal,
        parentId: turn.parentId,
        role: turn.role,
        createdAt: turn.capturedAt.toISOString(),
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.tokens ? { tokens: turn.tokens } : {}),
        blocks: (blocksByTurn.get(turn.id) ?? []).map((block) => ({
          id: block.id,
          kind: block.kind,
          ...(block.text !== null ? { text: block.text } : {}),
          ...(block.name !== null ? { name: block.name } : {}),
          ...(block.callId !== null ? { callId: block.callId } : {}),
          ...(block.language !== null ? { language: block.language } : {}),
          ...(block.mimeType !== null ? { mimeType: block.mimeType } : {}),
          ...(block.artifactRef !== null ? { artifactRef: block.artifactRef } : {}),
          ...(block.data !== null ? { data: block.data } : {}),
          ...(block.ext !== null ? { ext: block.ext } : {}),
        })),
        ...(turn.ext ? { ext: turn.ext } : {}),
      })),
      ...(session.ext ? { ext: session.ext } : {}),
      redactionStatus: session.redactionStatus,
  };
}
