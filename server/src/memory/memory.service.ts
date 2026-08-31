import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { MemoryDocument, MemoryRevision } from "../../libs/canonical/src/generated.js";
import type { MemoryStore, TenantContext } from "../archive-store.js";
import { ARCHIVE_STORE } from "../tokens.js";
import type { CaptureMemoryDto } from "./memory.dto.js";

@Injectable()
export class MemoryService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: MemoryStore) {}

  async list(context: TenantContext, filter: { machineId?: string; scope?: string }): Promise<{ items: MemoryDocument[] }> {
    return { items: await this.store.listMemoryDocuments(context, filter) };
  }

  async get(context: TenantContext, documentId: string): Promise<{ document: MemoryDocument; revisions: MemoryRevision[] }> {
    const document = await this.store.getMemoryDocument(context, documentId);
    if (!document) throw new NotFoundException("Memory document not found");
    return { document, revisions: await this.store.listMemoryRevisions(context, documentId) };
  }

  /**
   * The hash is computed here rather than trusted from the agent: it decides
   * whether a reading is a change, and a caller that got it wrong — or chose it
   * — could hide an edit or invent one.
   */
  capture(context: TenantContext, input: CaptureMemoryDto): Promise<{ document: MemoryDocument; revision: MemoryRevision | null }> {
    return this.store.captureMemoryDocument(context, {
      ...input,
      // The name of the file, which the path already says. Taking it from the
      // caller only creates a way for a document to be titled CLAUDE.md while
      // living at AGENTS.md.
      title: input.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? input.path,
      contentHash: createHash("sha256").update(input.text, "utf8").digest("hex"),
      visibility: { scope: "private", ownerId: context.userId },
      provenance: [{ kind: "native", sourceId: input.path, capturedAt: input.capturedAt, parserVersion: "memory:1" }],
    });
  }

  async remove(context: TenantContext, documentId: string): Promise<void> {
    if (!await this.store.deleteMemoryDocument(context, documentId)) throw new NotFoundException("Memory document not found");
  }
}
