import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ArchivedSession, CollectionRecord, CollectionStore, SessionStore, TeamStore, TenantContext } from "../archive-store.js";
import { uuidV7 } from "../ids.js";
import { sessionSummary } from "../sessions.js";
import { ARCHIVE_STORE } from "../tokens.js";
import type { CreateCollectionDto } from "./collections.dto.js";

function collectionResponse(collection: CollectionRecord): Record<string, unknown> {
  return {
    id: collection.id,
    name: collection.name,
    ...(collection.description ? { description: collection.description } : {}),
    ...(collection.teamId ? { teamId: collection.teamId } : {}),
    sessionCount: collection.sessionIds.length,
    updatedAt: collection.updatedAt,
  };
}

@Injectable()
export class CollectionService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: CollectionStore & SessionStore & TeamStore) {}

  async list(context: TenantContext): Promise<{ items: Record<string, unknown>[] }> {
    return { items: (await this.store.listCollections(context)).map(collectionResponse) };
  }

  async create(context: TenantContext, body: CreateCollectionDto): Promise<Record<string, unknown>> {
    if (body.teamId && !await this.store.isTeamMember(body.teamId, context.userId)) {
      throw new ForbiddenException("Caller is not a member of that team");
    }
    const collection: CollectionRecord = {
      id: uuidV7(),
      tenantId: context.tenantId,
      name: body.name,
      ...(body.description ? { description: body.description } : {}),
      ...(body.teamId ? { teamId: body.teamId } : {}),
      sessionIds: [],
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveCollection(context, collection);
    return collectionResponse(collection);
  }

  private async requireCollection(context: TenantContext, collectionId: string): Promise<CollectionRecord> {
    const collection = (await this.store.listCollections(context)).find((item) => item.id === collectionId);
    if (!collection) throw new NotFoundException("Collection not found");
    return collection;
  }

  async listSessions(context: TenantContext, collectionId: string): Promise<{ items: Record<string, unknown>[] }> {
    const collection = await this.requireCollection(context, collectionId);
    const sessions = await Promise.all(collection.sessionIds.map((sessionId) => this.store.getSession(context, sessionId)));
    return { items: sessions.filter((session): session is ArchivedSession => session !== null).map(sessionSummary) };
  }

  async setMembership(context: TenantContext, collectionId: string, sessionId: string, present: boolean): Promise<void> {
    const collection = (await this.store.listCollections(context)).find((item) => item.id === collectionId);
    if (!collection || !await this.store.getSession(context, sessionId)) throw new NotFoundException("Collection or session not found");
    const members = new Set(collection.sessionIds);
    if (present) members.add(sessionId);
    else members.delete(sessionId);
    await this.store.saveCollection(context, { ...collection, sessionIds: [...members], updatedAt: new Date().toISOString() });
  }
}
