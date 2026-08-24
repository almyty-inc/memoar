import { CollectionEntity, CollectionSessionEntity } from "../../entities.js";
import { uuidV7 } from "../../ids.js";
import type { TenantContext } from "../context.js";
import type { CollectionStore } from "../interfaces.js";
import type { CollectionRecord } from "../records.js";
import { TenantRunner } from "./runner.js";

export class PostgresCollectionStore implements CollectionStore {
  constructor(private readonly runner: TenantRunner) {}

  async listCollections(context: TenantContext): Promise<CollectionRecord[]> {
    return this.runner.inTenant(context, async (manager) => {
      const rows = await manager.getRepository(CollectionEntity).findBy({ tenantId: context.tenantId });
      const memberships = await manager.getRepository(CollectionSessionEntity).findBy({ tenantId: context.tenantId });
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        ...(row.teamId ? { teamId: row.teamId } : {}),
        sessionIds: memberships.filter((membership) => membership.collectionId === row.id).map((membership) => membership.sessionId),
        updatedAt: row.updatedAt.toISOString(),
      }));
    });
  }

  async saveCollection(context: TenantContext, collection: CollectionRecord): Promise<void> {
    await this.runner.inTenant(context, async (manager) => {
      const repository = manager.getRepository(CollectionEntity);
      await repository.upsert(repository.create({
        id: collection.id,
        tenantId: context.tenantId,
        name: collection.name,
        description: collection.description ?? null,
        teamId: collection.teamId ?? null,
      }), ["id"]);
      const memberships = manager.getRepository(CollectionSessionEntity);
      await memberships.delete({ tenantId: context.tenantId, collectionId: collection.id });
      if (collection.sessionIds.length) await memberships.save(collection.sessionIds.map((sessionId) => memberships.create({
        id: uuidV7(), tenantId: context.tenantId, collectionId: collection.id, sessionId,
      })));
    });
  }
}
