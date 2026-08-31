import type { MemoryDocument, MemoryRevision } from "../../../libs/canonical/src/generated.js";
import { MemoryDocumentEntity, MemoryRevisionEntity, type MemoryDocumentRow, type MemoryRevisionRow } from "../../entities.js";
import { uuidV5, uuidV7 } from "../../ids.js";
import type { TenantContext } from "../context.js";
import type { MemoryStore, MemoryCapture } from "../interfaces.js";
import { TenantRunner } from "./runner.js";

function toDocument(row: MemoryDocumentRow): MemoryDocument {
  return {
    id: row.id,
    scope: row.scope,
    machineId: row.machineId,
    path: row.path,
    title: row.title,
    readers: row.readers,
    contentHash: row.contentHash,
    capturedAt: row.capturedAt.toISOString(),
    visibility: row.visibility,
    provenance: row.provenance ?? [],
    ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
  };
}

function toRevision(row: MemoryRevisionRow): MemoryRevision {
  return {
    id: row.id,
    documentId: row.documentId,
    contentHash: row.contentHash,
    text: row.text,
    size: row.size,
    capturedAt: row.capturedAt.toISOString(),
  };
}

export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly runner: TenantRunner) {}

  async listMemoryDocuments(context: TenantContext, filter: { machineId?: string; scope?: string } = {}): Promise<MemoryDocument[]> {
    return this.runner.inTenant(context, async (manager) => {
      const rows = await manager.getRepository(MemoryDocumentEntity).find({
        where: {
          tenantId: context.tenantId,
          ...(filter.machineId ? { machineId: filter.machineId } : {}),
          ...(filter.scope ? { scope: filter.scope as MemoryDocument["scope"] } : {}),
        },
        order: { path: "ASC" },
      });
      return rows.map(toDocument);
    });
  }

  async getMemoryDocument(context: TenantContext, documentId: string): Promise<MemoryDocument | null> {
    return this.runner.inTenant(context, async (manager) => {
      const row = await manager.getRepository(MemoryDocumentEntity).findOneBy({ id: documentId, tenantId: context.tenantId });
      return row ? toDocument(row) : null;
    });
  }

  async listMemoryRevisions(context: TenantContext, documentId: string): Promise<MemoryRevision[]> {
    return this.runner.inTenant(context, async (manager) => {
      const rows = await manager.getRepository(MemoryRevisionEntity).find({
        where: { tenantId: context.tenantId, documentId },
        // Ids are time-ordered, so they settle two captures that share a
        // timestamp. Without a tiebreaker "newest first" has no defined answer
        // and the two store implementations are free to disagree.
        order: { capturedAt: "DESC", id: "DESC" },
      });
      return rows.map(toRevision);
    });
  }

  /**
   * Records a capture of one memory file.
   *
   * The identity is where the file lives, so capturing it again after an edit
   * updates the document rather than creating a second one. Unchanged content
   * adds nothing: the agent re-reads these files on a timer and almost always
   * finds them exactly as they were.
   */
  async captureMemoryDocument(context: TenantContext, capture: MemoryCapture): Promise<{ document: MemoryDocument; revision: MemoryRevision | null }> {
    return this.runner.inTenant(context, async (manager) => {
      const documents = manager.getRepository(MemoryDocumentEntity);
      // Derived, so the same file has the same id however often it is captured
      // and whichever process captures it.
      const id = uuidV5(`${context.tenantId}:memory:${capture.machineId}:${capture.path}`);
      const existing = await documents.findOneBy({ id, tenantId: context.tenantId });

      await documents.save(documents.create({
        id,
        tenantId: context.tenantId,
        scope: capture.scope,
        machineId: capture.machineId,
        workspacePath: capture.workspacePath ?? null,
        path: capture.path,
        title: capture.title,
        readers: capture.readers,
        contentHash: capture.contentHash,
        capturedAt: new Date(capture.capturedAt),
        visibility: capture.visibility,
        provenance: capture.provenance ?? [],
      }));

      if (existing?.contentHash === capture.contentHash) {
        const unchanged = await documents.findOneByOrFail({ id, tenantId: context.tenantId });
        return { document: toDocument(unchanged), revision: null };
      }

      const revisions = manager.getRepository(MemoryRevisionEntity);
      const already = await revisions.findOneBy({ tenantId: context.tenantId, documentId: id, contentHash: capture.contentHash });
      // A file edited and then reverted returns to a revision that is already
      // recorded; that is the same text, not a new one.
      const revision = already ?? await revisions.save(revisions.create({
        id: uuidV7(),
        tenantId: context.tenantId,
        documentId: id,
        contentHash: capture.contentHash,
        text: capture.text,
        size: Buffer.byteLength(capture.text, "utf8"),
        capturedAt: new Date(capture.capturedAt),
      }));

      const saved = await documents.findOneByOrFail({ id, tenantId: context.tenantId });
      return { document: toDocument(saved), revision: toRevision(revision) };
    });
  }

  async deleteMemoryDocument(context: TenantContext, documentId: string): Promise<boolean> {
    return this.runner.inTenant(context, async (manager) => (await manager.getRepository(MemoryDocumentEntity)
      .delete({ id: documentId, tenantId: context.tenantId })).affected === 1);
  }
}
