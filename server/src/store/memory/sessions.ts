/* eslint-disable @typescript-eslint/require-await -- in-memory store methods intentionally satisfy the asynchronous production port. */
import type { Visibility } from "../../../libs/canonical/src/generated.js";
import type { ArchivedSession, SessionFilter, SessionHeader, SessionHeaderPage, SessionPage, TenantContext } from "../context.js";
import type { SessionParse, SessionStore } from "../interfaces.js";
import { firstUnheld } from "../identity-proposal.js";
import { withoutNulBytes } from "../nul-bytes.js";
import { scopeCollidingIds, separateRepeatedIds } from "../turn-identity.js";
import { copy, key, type MemoryTables } from "./tables.js";
import { headerOf } from "../session-header.js";

export class MemorySessionStore implements SessionStore {
  constructor(private readonly tables: MemoryTables) {}

  // Cleaned the way Postgres is forced to be, so a test against this store sees
  // what production would return rather than a byte production cannot hold.
  // Turn and block ids any other session holds, in any account, are rescoped
  // the same way too: see `scopeCollidingIds`. This store never collided,
  // because it keys rows by session, which is exactly why it could not have
  // caught the Postgres bug.
  async saveSession(context: TenantContext, captured: ArchivedSession): Promise<void> {
    const cleaned = withoutNulBytes(captured);
    const elsewhere = { turns: new Set<string>(), blocks: new Set<string>() };
    const here = { turns: new Set<string>(), blocks: new Set<string>() };
    const ownKey = key(context.tenantId, cleaned.id);
    for (const [entryKey, other] of this.tables.sessions) {
      const target = entryKey === ownKey ? here : elsewhere;
      for (const turn of other.turns) {
        target.turns.add(turn.id);
        for (const block of turn.blocks) target.blocks.add(block.id);
      }
    }
    this.tables.sessions.set(ownKey, copy(separateRepeatedIds(scopeCollidingIds(cleaned, elsewhere, here))));
  }

  async resolveSessionIdentity(
    context: TenantContext,
    identity: { sourceTool: string; sourceVersion: string; nativeSessionId: string },
    proposedSessionIds: string | readonly string[],
  ): Promise<string> {
    const identityKey = key(context.tenantId, `${identity.sourceTool}:${identity.nativeSessionId}`);
    const existing = this.tables.sessionIdentities.get(identityKey);
    if (existing) return existing;
    const held = new Set<string>();
    for (const [entryKey, sessionId] of this.tables.sessionIdentities) {
      if (entryKey.startsWith(key(context.tenantId, ""))) held.add(sessionId);
    }
    const chosen = firstUnheld(proposedSessionIds, held);
    this.tables.sessionIdentities.set(identityKey, chosen);
    return chosen;
  }

  async saveSessionEmbedding(context: TenantContext, sessionId: string, vector: readonly number[]): Promise<void> {
    this.tables.sessionEmbeddings.set(key(context.tenantId, sessionId), [...vector]);
  }

  getSessionEmbedding(context: TenantContext, sessionId: string): readonly number[] | null {
    return this.tables.sessionEmbeddings.get(key(context.tenantId, sessionId)) ?? null;
  }

  async updateSessionVisibility(context: TenantContext, sessionId: string, visibility: Visibility): Promise<boolean> {
    const session = this.tables.sessions.get(key(context.tenantId, sessionId));
    if (!session) return false;
    session.visibility = copy(visibility);
    return true;
  }

  async listSessions(context: TenantContext, filter: SessionFilter): Promise<SessionPage> {
    const cursor = filter.cursor ? Buffer.from(filter.cursor, "base64url").toString("utf8") : null;
    const items = [...this.tables.sessions.entries()]
      .filter(([entryKey]) => entryKey.startsWith(`${context.tenantId}:`))
      .map(([, session]) => session)
      .filter((session) => !filter.agent || session.source.tool === filter.agent)
      .filter((session) => !filter.workspace || session.workspace.path.includes(filter.workspace))
      .filter((session) => !filter.machineId || session.source.machineId === filter.machineId)
      .filter((session) => !filter.model || session.models.includes(filter.model))
      .filter((session) => !filter.from || new Date(session.updatedAt) >= filter.from)
      .filter((session) => !filter.to || new Date(session.updatedAt) <= filter.to)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    // How many match the filter, counted before the cursor narrows it to a page.
    const total = items.length;
    const afterCursor = items.filter((session) => !cursor || `${session.updatedAt}|${session.id}` < cursor);
    const page = afterCursor.slice(0, filter.limit);
    const last = page.at(-1);
    return {
      items: copy(page),
      total,
      nextCursor: afterCursor.length > page.length && last
        ? Buffer.from(`${last.updatedAt}|${last.id}`).toString("base64url")
        : null,
    };
  }

  async listSessionHeaders(context: TenantContext, filter: SessionFilter): Promise<SessionHeaderPage> {
    const page = await this.listSessions(context, filter);
    return { ...page, items: page.items.map(headerOf) };
  }

  async getSession(context: TenantContext, sessionId: string): Promise<ArchivedSession | null> {
    const session = this.tables.sessions.get(key(context.tenantId, sessionId));
    return session ? copy(session) : null;
  }

  sessionParserVersions(context: TenantContext): Promise<Map<string, SessionParse>> {
    const versions = new Map<string, SessionParse>();
    const prefix = key(context.tenantId, "");
    for (const [entry, session] of this.tables.sessions) {
      if (!entry.startsWith(prefix)) continue;
      versions.set(session.id, {
        parserVersion: session.provenance.find((item) => item.kind === "native")?.parserVersion ?? null,
        machineId: session.source.machineId || null,
        title: session.title ?? null,
        tool: session.source.tool ?? null,
      });
    }
    return Promise.resolve(versions);
  }

  countSessionsByMachineSource(context: TenantContext): Promise<{ machineId: string; tool: string; sessions: number }[]> {
    const counts = new Map<string, { machineId: string; tool: string; sessions: number }>();
    // The table is keyed by tenant, so the prefix is what scopes this.
    const prefix = key(context.tenantId, "");
    for (const [entry, session] of this.tables.sessions) {
      if (!entry.startsWith(prefix)) continue;
      const machineId = session.source.machineId;
      if (!machineId) continue;
      const key = `${machineId}:${session.source.tool}`;
      const existing = counts.get(key);
      if (existing) existing.sessions += 1;
      else counts.set(key, { machineId, tool: session.source.tool, sessions: 1 });
    }
    return Promise.resolve([...counts.values()]);
  }

  sessionExists(context: TenantContext, sessionId: string): Promise<boolean> {
    return Promise.resolve(this.tables.sessions.has(key(context.tenantId, sessionId)));
  }

  async getSessions(context: TenantContext, sessionIds: readonly string[]): Promise<ArchivedSession[]> {
    const found: ArchivedSession[] = [];
    for (const sessionId of sessionIds) {
      const session = this.tables.sessions.get(key(context.tenantId, sessionId));
      if (session) found.push(copy(session));
    }
    return found;
  }

  async getSessionHeaders(context: TenantContext, sessionIds: readonly string[]): Promise<SessionHeader[]> {
    return (await this.getSessions(context, sessionIds)).map(headerOf);
  }

  async deleteSession(context: TenantContext, sessionId: string): Promise<boolean> {
    return this.tables.sessions.delete(key(context.tenantId, sessionId));
  }
}
