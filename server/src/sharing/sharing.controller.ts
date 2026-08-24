import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import type { TenantContext, TransferRecord } from "../archive-store.js";
import { Public, Tenant } from "../auth.js";
import { CreateShareLinkDto, RequestTransferDto, UpdateVisibilityDto } from "./sharing.dto.js";
import { SharingService } from "./sharing.service.js";

@Controller("sharing")
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  @Get("links")
  listLinks(@Tenant() context: TenantContext): Promise<{ items: Record<string, unknown>[] }> {
    return this.sharing.listLinks(context);
  }

  @Post("links")
  createLink(@Tenant() context: TenantContext, @Body() body: CreateShareLinkDto): Promise<Record<string, unknown>> {
    return this.sharing.createLink(context, body);
  }

  @Delete("grants/:grantId")
  @HttpCode(204)
  revoke(@Tenant() context: TenantContext, @Param("grantId", ParseUUIDPipe) grantId: string): Promise<void> {
    return this.sharing.revoke(context, grantId);
  }

  @Get("transfers")
  async listTransfers(@Tenant() context: TenantContext): Promise<{ items: TransferRecord[] }> {
    return { items: await this.sharing.listTransfers(context) };
  }

  @Post("transfers")
  requestTransfer(@Tenant() context: TenantContext, @Body() body: RequestTransferDto): Promise<TransferRecord> {
    return this.sharing.requestTransfer(context, body, `${context.userId}@local.invalid`);
  }

  @Post("transfers/:transferId/accept")
  accept(@Tenant() context: TenantContext, @Param("transferId", ParseUUIDPipe) transferId: string): Promise<Record<string, unknown>> {
    return this.sharing.acceptTransfer(context, transferId);
  }
}

/** Public link consumption and authenticated import of a shared session. */
@Controller("shares")
export class ShareConsumeController {
  constructor(private readonly sharing: SharingService) {}

  @Public()
  @Get(":token")
  consume(@Param("token") token: string): Promise<Record<string, unknown>> {
    return this.sharing.consumeShare(token);
  }

  @Post(":token/import")
  @HttpCode(201)
  import(@Tenant() context: TenantContext, @Param("token") token: string): Promise<Record<string, unknown>> {
    return this.sharing.importShare(context, token);
  }
}

/** Session-scoped redaction review completion and visibility changes. */
@Controller("sessions")
export class RedactionReviewController {
  constructor(private readonly sharing: SharingService) {}

  @Post(":sessionId/redaction-reviews")
  @HttpCode(201)
  async complete(
    @Tenant() context: TenantContext,
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
  ): Promise<Record<string, unknown>> {
    const review = await this.sharing.completeReview(context, sessionId);
    return {
      id: review.id,
      sessionId: review.sessionId,
      status: review.status,
      contentDigest: review.contentDigest,
      maskCount: review.masks.length,
      masks: review.masks,
      completedAt: review.completedAt,
    };
  }

  @Patch(":sessionId")
  updateVisibility(
    @Tenant() context: TenantContext,
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Body() body: UpdateVisibilityDto,
  ): Promise<Record<string, unknown>> {
    return this.sharing.updateVisibility(context, sessionId, body);
  }
}
