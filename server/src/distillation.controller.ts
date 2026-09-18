// The routes distillation serves.
// Split out of distillation.ts, which was over the file-size rule.

import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import type { TenantContext } from "./archive-store.js";
import { Tenant } from "./auth.js";
import { ExportProjectMemoryQueryDto, UpdateDistillationSettingsDto } from "./settings.dto.js";
import { DistillationService } from "./distillation.service.js";

@Controller("distillation")
export class DistillationController {
  constructor(private readonly distillation: DistillationService) {}

  @Get("settings")
  getSettings(@Tenant() context: TenantContext) { return this.distillation.getSettings(context); }

  @Put("settings")
  updateSettings(@Tenant() context: TenantContext, @Body() body: UpdateDistillationSettingsDto) {
    return this.distillation.updateSettings(context, body);
  }

  @Get("jobs/:jobId")
  getJob(@Tenant() context: TenantContext, @Param("jobId", ParseUUIDPipe) jobId: string) { return this.distillation.getJob(context, jobId); }

  @Post("sessions/:sessionId")
  @HttpCode(202)
  run(@Tenant() context: TenantContext, @Param("sessionId", ParseUUIDPipe) sessionId: string) { return this.distillation.run(context, sessionId); }

  @Post("projects/export")
  export(@Tenant() context: TenantContext, @Query() query: ExportProjectMemoryQueryDto) {
    return this.distillation.exportProjectMemory(context, query.workspace, query.format ?? "agents");
  }
}
