import type { Annotation } from "../../../libs/canonical/src/generated.js";
import { AnnotationEntity } from "../../entities.js";
import { uuidV7 } from "../../ids.js";
import type { TenantContext } from "../context.js";
import type { AnnotationStore } from "../interfaces.js";
import { TenantRunner } from "./runner.js";
import type { PostgresSessionStore } from "./sessions.js";

function toAnnotation(row: AnnotationEntity): Annotation {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    value: row.value,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.turnId ? { turnId: row.turnId } : {}),
    ...(row.blockId ? { blockId: row.blockId } : {}),
  };
}

export class PostgresAnnotationStore implements AnnotationStore {
  constructor(private readonly runner: TenantRunner, private readonly sessions: PostgresSessionStore) {}

  async listAnnotations(context: TenantContext, sessionId?: string): Promise<Annotation[]> {
    return this.runner.inTenant(context, async (manager) => {
      const where = sessionId ? { tenantId: context.tenantId, sessionId } : { tenantId: context.tenantId };
      const rows = await manager.getRepository(AnnotationEntity).find({ where, order: { createdAt: "ASC" } });
      return rows.map(toAnnotation);
    });
  }

  async createAnnotation(
    context: TenantContext,
    input: Parameters<AnnotationStore["createAnnotation"]>[1],
  ): Promise<Annotation> {
    return this.runner.inTenant(context, async (manager) => {
      if (!await this.sessions.getSessionWithManager(manager, context, input.sessionId)) throw new Error("session_not_found");
      const repository = manager.getRepository(AnnotationEntity);
      const row = await repository.save(repository.create({
        id: uuidV7(),
        tenantId: context.tenantId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        blockId: input.blockId ?? null,
        kind: input.kind,
        value: input.value,
      }));
      return toAnnotation(row);
    });
  }

  async updateAnnotation(context: TenantContext, annotationId: string, value: Record<string, unknown>): Promise<Annotation | null> {
    return this.runner.inTenant(context, async (manager) => {
      const repository = manager.getRepository(AnnotationEntity);
      const row = await repository.findOneBy({ id: annotationId, tenantId: context.tenantId });
      if (!row) return null;
      row.value = value;
      return toAnnotation(await repository.save(row));
    });
  }

  async deleteAnnotation(context: TenantContext, annotationId: string): Promise<boolean> {
    return this.runner.inTenant(context, async (manager) => (await manager.getRepository(AnnotationEntity)
      .delete({ id: annotationId, tenantId: context.tenantId })).affected === 1);
  }
}
