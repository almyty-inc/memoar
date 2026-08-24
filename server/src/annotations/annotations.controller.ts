import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import type { Annotation } from "../../libs/canonical/src/generated.js";
import type { TenantContext } from "../archive-store.js";
import { Tenant } from "../auth.js";
import { Patch } from "@nestjs/common";
import { CreateAnnotationDto, UpdateAnnotationDto } from "./annotations.dto.js";
import { AnnotationService } from "./annotations.service.js";

@Controller("annotations")
export class AnnotationController {
  constructor(private readonly annotations: AnnotationService) {}

  @Get()
  list(@Tenant() context: TenantContext, @Query("sessionId") sessionId?: string): Promise<{ items: Annotation[] }> {
    return this.annotations.list(context, sessionId || undefined);
  }

  @Post()
  create(@Tenant() context: TenantContext, @Body() body: CreateAnnotationDto): Promise<Annotation> {
    return this.annotations.create(context, body);
  }

  @Patch(":annotationId")
  update(
    @Tenant() context: TenantContext,
    @Param("annotationId", ParseUUIDPipe) id: string,
    @Body() body: UpdateAnnotationDto,
  ): Promise<Annotation> {
    return this.annotations.update(context, id, body.value);
  }

  @Delete(":annotationId")
  @HttpCode(204)
  remove(@Tenant() context: TenantContext, @Param("annotationId", ParseUUIDPipe) id: string): Promise<void> {
    return this.annotations.remove(context, id);
  }
}
