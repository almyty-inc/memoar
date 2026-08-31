import type { MemoryDocument, MemoryRevision } from "../../../libs/canonical/src/generated.js";
import { uuidV5, uuidV7 } from "../../ids.js";
import type { TenantContext } from "../context.js";
import type { MemoryCapture, MemoryStore } from "../interfaces.js";
import { copy, key, type MemoryTables } from "./tables.js";

export class MemoryMemoryDocumentStore implements MemoryStore {
  constructor(private readonly tables: MemoryTables) {}

  private documentsFor(context: TenantContext): (MemoryDocument & { tenantId: string })[] {
    return [...this.tables.memoryDocuments.values()].filter((document) => document.tenantId === context.tenantId);
  }

  listMemoryDocuments(context: TenantContext, filter: { machineId?: string; scope?: string } = {}): Promise<MemoryDocument[]> {
    const documents = this.documentsFor(context)
      .filter((document) => (!filter.machineId || document.machineId === filter.machineId)
        && (!filter.scope || document.scope === filter.scope))
      .sort((left, right) => left.path.localeCompare(right.path));
    return Promise.resolve(documents.map((document) => copy(document)));
  }

  getMemoryDocument(context: TenantContext, documentId: string): Promise<MemoryDocument | null> {
    const document = this.tables.memoryDocuments.get(key(context.tenantId, documentId));
    return Promise.resolve(document ? copy(document) : null);
  }

  listMemoryRevisions(context: TenantContext, documentId: string): Promise<MemoryRevision[]> {
    const revisions = [...this.tables.memoryRevisions.values()]
      .filter((revision) => revision.tenantId === context.tenantId && revision.documentId === documentId)
      // Ids are time-ordered, so they settle two captures that share a
      // timestamp; otherwise "newest first" has no defined answer.
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id));
    return Promise.resolve(revisions.map((revision) => copy(revision)));
  }

  captureMemoryDocument(context: TenantContext, capture: MemoryCapture): Promise<{ document: MemoryDocument; revision: MemoryRevision | null }> {
    const id = uuidV5(`${context.tenantId}:memory:${capture.machineId}:${capture.path}`);
    const existing = this.tables.memoryDocuments.get(key(context.tenantId, id));
    const document: MemoryDocument & { tenantId: string } = {
      id,
      tenantId: context.tenantId,
      scope: capture.scope,
      machineId: capture.machineId,
      path: capture.path,
      title: capture.title,
      readers: [...capture.readers],
      contentHash: capture.contentHash,
      capturedAt: capture.capturedAt,
      visibility: capture.visibility,
      provenance: capture.provenance ?? [],
      ...(capture.workspacePath ? { workspacePath: capture.workspacePath } : {}),
    };
    this.tables.memoryDocuments.set(key(context.tenantId, id), document);

    if (existing?.contentHash === capture.contentHash) return Promise.resolve({ document: copy(document), revision: null });

    const recorded = [...this.tables.memoryRevisions.values()]
      .find((revision) => revision.tenantId === context.tenantId && revision.documentId === id && revision.contentHash === capture.contentHash);
    if (recorded) return Promise.resolve({ document: copy(document), revision: copy(recorded) });

    const revision: MemoryRevision & { tenantId: string } = {
      id: uuidV7(),
      tenantId: context.tenantId,
      documentId: id,
      contentHash: capture.contentHash,
      text: capture.text,
      size: Buffer.byteLength(capture.text, "utf8"),
      capturedAt: capture.capturedAt,
    };
    this.tables.memoryRevisions.set(key(context.tenantId, revision.id), revision);
    return Promise.resolve({ document: copy(document), revision: copy(revision) });
  }

  deleteMemoryDocument(context: TenantContext, documentId: string): Promise<boolean> {
    const deleted = this.tables.memoryDocuments.delete(key(context.tenantId, documentId));
    for (const [entry, revision] of this.tables.memoryRevisions) {
      if (revision.tenantId === context.tenantId && revision.documentId === documentId) this.tables.memoryRevisions.delete(entry);
    }
    return Promise.resolve(deleted);
  }
}
