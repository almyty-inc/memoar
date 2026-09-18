import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import type { MemoryDocument, MemoryRevision } from "../../libs/canonical/src/generated.js";
import type { TenantContext } from "../archive-store.js";
import { RequireScopes, Tenant } from "../auth.js";
import type { MemoryConversionBundle } from "../convert/memory-conversion.js";
import { MemoryConversionService } from "./memory-conversion.service.js";
import { CaptureMemoryDto, ConvertMemoryDto, ListMemoryQueryDto, ReviewMemoryDto } from "./memory.dto.js";
import { MemoryService } from "./memory.service.js";

@Controller("memory")
export class MemoryController {
  constructor(
    private readonly memory: MemoryService,
    private readonly conversions: MemoryConversionService,
  ) {}

  @Get()
  list(
    @Tenant() context: TenantContext,
    @Query() query: ListMemoryQueryDto,
  ): Promise<{ items: MemoryDocument[] }> {
    return this.memory.list(context, {
      ...(query.machineId ? { machineId: query.machineId } : {}),
      ...(query.scope ? { scope: query.scope } : {}),
    });
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

  /*
    A mechanical port of standing instructions between tools.

    Read-only on the archive despite being a POST — the request carries a body
    describing what to port, and nothing about the archive changes — so the
    scope asked for is `archive:read` rather than the `archive:write` a POST
    would otherwise be taken to mean. The capture agent holds both.
  */
  @Post("conversions")
  @RequireScopes("archive:read")
  @HttpCode(200)
  convert(@Tenant() context: TenantContext, @Body() body: ConvertMemoryDto): Promise<MemoryConversionBundle> {
    return this.conversions.convert(context, body);
  }

  @Get(":documentId")
  get(@Tenant() context: TenantContext, @Param("documentId", ParseUUIDPipe) documentId: string): Promise<{ document: MemoryDocument; revisions: MemoryRevision[] }> {
    return this.memory.get(context, documentId);
  }

  /*
    The act of reviewing, which is what makes the gate a gate rather than a
    wall. Named for the review, not for the status it happens to set, so it
    reads the way `POST /sessions/:id/redaction-reviews` already does.
  */
  @Post(":documentId/redaction-reviews")
  @HttpCode(200)
  review(
    @Tenant() context: TenantContext,
    @Param("documentId", ParseUUIDPipe) documentId: string,
    @Body() body: ReviewMemoryDto,
  ): Promise<MemoryDocument> {
    return this.memory.review(context, documentId, body.contentHash);
  }

  @Delete(":documentId")
  @HttpCode(204)
  remove(@Tenant() context: TenantContext, @Param("documentId", ParseUUIDPipe) documentId: string): Promise<void> {
    return this.memory.remove(context, documentId);
  }
}
