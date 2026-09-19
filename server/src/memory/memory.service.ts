import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { MemoryDocument, MemoryRevision } from "../../libs/canonical/src/generated.js";
import type { MachineStore, MemoryStore, SettingsStore, TenantContext } from "../archive-store.js";
import { ARCHIVE_STORE } from "../tokens.js";
import { scanMemoryText } from "./memory-redaction.js";
import { matchesMemoryFilter, type MemoryDocumentFilter } from "./memory-filter.js";
import type { CaptureMemoryDto } from "./memory.dto.js";

@Injectable()
export class MemoryService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: MemoryStore & SettingsStore & MachineStore) {}

  async list(context: TenantContext, filter: { machineId?: string; scope?: string }): Promise<{ items: MemoryDocument[] }> {
    return { items: await this.store.listMemoryDocuments(context, filter) };
  }

  /**
   * The same listing, narrowed by workspace and file name and cut into pages.
   *
   * Machine and scope are columns, so the store applies them. Workspace and the
   * name pattern are applied to what comes back: an account's instruction files
   * number in the dozens, and pushing a caller's glob down would put a supplied
   * expression in front of the database for no gain. Either way every row comes
   * from the tenant-scoped listing, never from the entities.
   */
  async search(
    context: TenantContext,
    filter: MemoryDocumentFilter,
    page: { limit: number; offset: number },
  ): Promise<{ items: MemoryDocument[]; total: number; limit: number; offset: number }> {
    const { items } = await this.list(context, {
      ...(filter.machineId ? { machineId: filter.machineId } : {}),
      ...(filter.scope ? { scope: filter.scope } : {}),
    });
    const matched = items.filter((document) => matchesMemoryFilter(document, filter));
    return {
      items: matched.slice(page.offset, page.offset + page.limit),
      total: matched.length,
      limit: page.limit,
      offset: page.offset,
    };
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
   *
   * The scan happens here too, for the same reason it happens at ingest and
   * not later: a memory file is where people write "the staging key is sk-…",
   * and nobody re-reads one before it is passed on. Captured and never scanned
   * is how these were stored until now.
   *
   * The machine is resolved before anything is written. `machineId` is a third
   * of a document's identity — `memory_documents` is unique on tenant, machine
   * and path — and the guard pins it only for machine credentials, so a browser
   * session or an API key holding `ingest:write` could file under any uuid it
   * typed. A wrong one mints a parallel set of documents that no machine owns
   * and that `?machineId=` can never reconcile. Tenant-scoped, so another
   * account's machine is refused exactly as a missing one is, in the same words.
   */
  async capture(context: TenantContext, input: CaptureMemoryDto): Promise<{ document: MemoryDocument; revision: MemoryRevision | null }> {
    if (!await this.store.getMachine(context, input.machineId)) {
      throw new NotFoundException("No machine of this account with that id");
    }
    const settings = await this.store.getTenantSettings(context);
    return this.store.captureMemoryDocument(context, {
      ...input,
      ...scanMemoryText(input.text, settings.redaction),
      // The name of the file, which the path already says. Taking it from the
      // caller only creates a way for a document to be titled CLAUDE.md while
      // living at AGENTS.md.
      title: input.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? input.path,
      contentHash: createHash("sha256").update(input.text, "utf8").digest("hex"),
      visibility: { scope: "private", ownerId: context.userId },
      provenance: [{ kind: "native", sourceId: input.path, capturedAt: input.capturedAt, parserVersion: "memory:1" }],
    });
  }

  /**
   * A person says they have read what the scanner found and the file may go
   * out as it stands.
   *
   * The content hash the reviewer was looking at comes with the request: a
   * review is of one version of one file, and the agent may have captured
   * another while the person was reading. A mismatch is a conflict rather than
   * a quiet success, because the alternative is clearing text nobody has seen.
   */
  async review(context: TenantContext, documentId: string, contentHash: string): Promise<MemoryDocument> {
    const reviewed = await this.store.reviewMemoryDocument(context, documentId, contentHash);
    if (reviewed) return reviewed;
    if (!await this.store.getMemoryDocument(context, documentId)) throw new NotFoundException("Memory document not found");
    throw new ConflictException({
      type: "https://memoar.dev/problems/memory-review-stale",
      title: "Memory document changed since it was read",
      status: 409,
      code: "memory_review_stale",
      detail: "This file was captured again while it was being reviewed. Reload it and review what it says now.",
    });
  }

  async remove(context: TenantContext, documentId: string): Promise<void> {
    if (!await this.store.deleteMemoryDocument(context, documentId)) throw new NotFoundException("Memory document not found");
  }
}
