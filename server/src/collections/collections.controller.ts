import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import type { TenantContext } from "../archive-store.js";
import { Tenant } from "../auth.js";
import { CreateCollectionDto } from "./collections.dto.js";
import { CollectionService } from "./collections.service.js";

@Controller("collections")
export class CollectionController {
  constructor(private readonly collections: CollectionService) {}

  @Get()
  list(@Tenant() context: TenantContext): Promise<{ items: Record<string, unknown>[] }> {
    return this.collections.list(context);
  }

  @Post()
  create(@Tenant() context: TenantContext, @Body() body: CreateCollectionDto): Promise<Record<string, unknown>> {
    return this.collections.create(context, body);
  }

  @Get(":collectionId/sessions")
  listSessions(
    @Tenant() context: TenantContext,
    @Param("collectionId", ParseUUIDPipe) collectionId: string,
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.collections.listSessions(context, collectionId);
  }

  @Put(":collectionId/sessions/:sessionId")
  @HttpCode(204)
  add(
    @Tenant() context: TenantContext,
    @Param("collectionId", ParseUUIDPipe) collectionId: string,
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
  ): Promise<void> {
    return this.collections.setMembership(context, collectionId, sessionId, true);
  }

  @Delete(":collectionId/sessions/:sessionId")
  @HttpCode(204)
  remove(
    @Tenant() context: TenantContext,
    @Param("collectionId", ParseUUIDPipe) collectionId: string,
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
  ): Promise<void> {
    return this.collections.setMembership(context, collectionId, sessionId, false);
  }
}
