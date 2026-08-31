import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import type { MemoryDocument, MemoryRevision } from "../../libs/canonical/src/generated.js";
import type { TenantContext } from "../archive-store.js";
import { RequireScopes, Tenant } from "../auth.js";
import { CaptureMemoryDto } from "./memory.dto.js";
import { MemoryService } from "./memory.service.js";

@Controller("memory")
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get()
  list(
    @Tenant() context: TenantContext,
    @Query("machineId") machineId?: string,
    @Query("scope") scope?: string,
  ): Promise<{ items: MemoryDocument[] }> {
    return this.memory.list(context, { ...(machineId ? { machineId } : {}), ...(scope ? { scope } : {}) });
  }

  @Post()
  // The capture agent writes these, and it holds a machine token: the same
  // credential and the same class of write as uploading a transcript. Inferring
  // archive:write from the method would have locked the only caller out.
  @RequireScopes("ingest:write")
  // A reading is not always a creation: when the file has not changed it
  // records nothing, and a status that varied with the outcome would only make
  // callers guess.
  @HttpCode(200)
  capture(@Tenant() context: TenantContext, @Body() body: CaptureMemoryDto): Promise<{ document: MemoryDocument; revision: MemoryRevision | null }> {
    return this.memory.capture(context, body);
  }

  @Get(":documentId")
  get(@Tenant() context: TenantContext, @Param("documentId", ParseUUIDPipe) documentId: string): Promise<{ document: MemoryDocument; revisions: MemoryRevision[] }> {
    return this.memory.get(context, documentId);
  }

  @Delete(":documentId")
  @HttpCode(204)
  remove(@Tenant() context: TenantContext, @Param("documentId", ParseUUIDPipe) documentId: string): Promise<void> {
    return this.memory.remove(context, documentId);
  }
}
