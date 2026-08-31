/* eslint-disable @typescript-eslint/require-await -- in-memory store methods intentionally satisfy the asynchronous production port. */
import type { Annotation, AnnotationKind } from "../../../libs/canonical/src/generated.js";
import { uuidV7 } from "../../ids.js";
import type { TenantContext } from "../context.js";
import type { AnnotationStore, CollectionStore } from "../interfaces.js";
import type { CollectionRecord } from "../records.js";
import type { MemorySessionStore } from "./sessions.js";
import { copy, key, type MemoryTables } from "./tables.js";

function publicAnnotation(annotation: Annotation & { tenantId: string }): Annotation {
  const result = copy(annotation);
  Reflect.deleteProperty(result, "tenantId");
  return result;
}

export class MemoryAnnotationStore implements AnnotationStore {
  constructor(private readonly tables: MemoryTables, private readonly sessions: MemorySessionStore) {}

  async listAnnotations(context: TenantContext, sessionId?: string): Promise<Annotation[]> {
    return [...this.tables.annotations.values()]
      .filter((annotation) => annotation.tenantId === context.tenantId)
      .filter((annotation) => !sessionId || annotation.sessionId === sessionId)
      .map(publicAnnotation);
  }

  async createAnnotation(
    context: TenantContext,
    input: { sessionId: string; turnId?: string; blockId?: string; kind: AnnotationKind; value: Record<string, unknown> },
  ): Promise<Annotation> {
    if (!await this.sessions.getSession(context, input.sessionId)) throw new Error("session_not_found");
    const now = new Date().toISOString();
    const annotation: Annotation & { tenantId: string } = {
      id: uuidV7(),
      tenantId: context.tenantId,
      sessionId: input.sessionId,
      kind: input.kind,
      value: copy(input.value),
      createdAt: now,
      updatedAt: now,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.blockId ? { blockId: input.blockId } : {}),
    };
    this.tables.annotations.set(key(context.tenantId, annotation.id), annotation);
    return publicAnnotation(annotation);
  }

  async replaceAnnotations(
    context: TenantContext,
    sessionId: string,
    kind: AnnotationKind,
    values: Record<string, unknown>[],
  ): Promise<Annotation[]> {
    for (const [entry, annotation] of this.tables.annotations) {
      if (annotation.tenantId === context.tenantId && annotation.sessionId === sessionId && annotation.kind === kind) {
        this.tables.annotations.delete(entry);
      }
    }
    const created: Annotation[] = [];
    for (const value of values) created.push(await this.createAnnotation(context, { sessionId, kind, value }));
    return created;
  }

  async updateAnnotation(context: TenantContext, annotationId: string, value: Record<string, unknown>): Promise<Annotation | null> {
    const annotation = this.tables.annotations.get(key(context.tenantId, annotationId));
    if (!annotation) return null;
    annotation.value = copy(value);
    annotation.updatedAt = new Date().toISOString();
    return publicAnnotation(annotation);
  }

  async deleteAnnotation(context: TenantContext, annotationId: string): Promise<boolean> {
    return this.tables.annotations.delete(key(context.tenantId, annotationId));
  }
}

export class MemoryCollectionStore implements CollectionStore {
  constructor(private readonly tables: MemoryTables) {}

  async listCollections(context: TenantContext): Promise<CollectionRecord[]> {
    return [...this.tables.collections.values()].filter((item) => item.tenantId === context.tenantId).map(copy);
  }

  async saveCollection(context: TenantContext, collection: CollectionRecord): Promise<void> {
    if (collection.tenantId !== context.tenantId) throw new Error("tenant_mismatch");
    this.tables.collections.set(key(context.tenantId, collection.id), copy(collection));
  }
}
