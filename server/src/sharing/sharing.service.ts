import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { Visibility } from "../../libs/canonical/src/generated.js";
import type {
  AnnotationStore, ArchivedSession, RedactionReviewRecord, SessionStore,
  ShareGrantRecord, SharingStore, ShareTokenLookup, TenantContext, TransferRecord,
} from "../archive-store.js";
import { copyTransferredSession } from "../archive-store.js";
import { uuidV7 } from "../ids.js";
import { applyRedactionProjection } from "../redaction.js";
import { canonicalProjection, sessionSummary } from "../sessions.js";
import { ARCHIVE_STORE } from "../tokens.js";
import type { CreateShareLinkDto, RequestTransferDto, UpdateVisibilityDto } from "./sharing.dto.js";

/** Digest of the content a redaction review was completed against. */
export function sessionContentDigest(session: ArchivedSession): string {
  const captured = {
    id: session.id,
    updatedAt: session.updatedAt,
    turns: session.turns,
    redactionStatus: session.redactionStatus,
  };
  return createHash("sha256").update(JSON.stringify(captured)).digest("hex");
}

@Injectable()
export class SharingService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: SessionStore & AnnotationStore & SharingStore) {}

  async completeReview(context: TenantContext, sessionId: string): Promise<RedactionReviewRecord> {
    const [session, annotations] = await Promise.all([
      this.store.getSession(context, sessionId),
      this.store.listAnnotations(context, sessionId),
    ]);
    if (!session) throw new NotFoundException("Session not found");
    const masks = annotations
      .filter((annotation) => annotation.kind === "redaction_mask")
      .map((annotation) => ({
        kind: typeof annotation.value.kind === "string" ? annotation.value.kind : "unknown",
        start: Number(annotation.value.start ?? 0),
        end: Number(annotation.value.end ?? 0),
        preview: typeof annotation.value.preview === "string" ? annotation.value.preview : "",
      }));
    const review: RedactionReviewRecord = {
      id: uuidV7(), tenantId: context.tenantId, sessionId, reviewerUserId: context.userId,
      status: "completed", contentDigest: sessionContentDigest(session), masks, completedAt: new Date().toISOString(),
    };
    await this.store.saveReview(context, review);
    return review;
  }

  private reviewRequired(detail: Record<string, unknown>): never {
    throw new ConflictException({
      type: "https://memoar.dev/problems/redaction-review-required",
      title: "Redaction review required",
      status: 409,
      code: "redaction_review_required",
      ...detail,
    });
  }

  /** Resolves a review that is completed and still matches the session's current content. */
  private async requireCurrentReview(context: TenantContext, sessionId: string, reviewId: string): Promise<ArchivedSession> {
    const [session, review] = await Promise.all([
      this.store.getSession(context, sessionId),
      this.store.getReview(context, reviewId),
    ]);
    if (!session) throw new NotFoundException("Session not found");
    if (!review || review.sessionId !== sessionId || review.status !== "completed" || review.contentDigest !== sessionContentDigest(session)) {
      this.reviewRequired({ reviewId });
    }
    return session;
  }

  async updateVisibility(context: TenantContext, sessionId: string, body: UpdateVisibilityDto): Promise<{ id: string; visibility: Visibility }> {
    let session: ArchivedSession;
    if (body.visibility.scope === "private") {
      const existing = await this.store.getSession(context, sessionId);
      if (!existing) throw new NotFoundException("Session not found");
      session = existing;
    } else {
      if (!body.redactionReviewId) {
        this.reviewRequired({ detail: "Widening visibility beyond private requires redactionReviewId referencing a completed review." });
      }
      session = await this.requireCurrentReview(context, sessionId, body.redactionReviewId);
    }
    const visibility: Visibility = {
      scope: body.visibility.scope,
      ownerId: session.visibility.ownerId,
      ...(body.visibility.teamId ? { teamId: body.visibility.teamId } : {}),
      ...(body.visibility.orgId ? { orgId: body.visibility.orgId } : {}),
    };
    await this.store.updateSessionVisibility(context, sessionId, visibility);
    return { id: sessionId, visibility };
  }

  async createLink(context: TenantContext, body: CreateShareLinkDto): Promise<Record<string, unknown>> {
    await this.requireCurrentReview(context, body.sessionId, body.redactionReviewId);
    const token = randomBytes(32).toString("base64url");
    const grant: ShareGrantRecord = {
      id: uuidV7(), tenantId: context.tenantId, sessionId: body.sessionId,
      permission: body.permission, tokenHash: createHash("sha256").update(token).digest("hex"),
      status: "active", createdAt: new Date().toISOString(), expiresAt: body.expiresAt ?? null,
    };
    await this.store.saveShareGrant(context, grant);
    return { id: grant.id, sessionId: grant.sessionId, permission: grant.permission, status: grant.status, token, createdAt: grant.createdAt, expiresAt: grant.expiresAt };
  }

  async listLinks(context: TenantContext): Promise<{ items: Record<string, unknown>[] }> {
    return { items: (await this.store.listShareGrants(context)).map((grant) => ({
      id: grant.id, sessionId: grant.sessionId, permission: grant.permission,
      status: grant.status, createdAt: grant.createdAt, expiresAt: grant.expiresAt,
    })) };
  }

  async revoke(context: TenantContext, grantId: string): Promise<void> {
    const grant = (await this.store.listShareGrants(context)).find((item) => item.id === grantId);
    if (!grant) throw new NotFoundException("Share grant not found");
    await this.store.saveShareGrant(context, { ...grant, status: "revoked" });
  }

  async requestTransfer(context: TenantContext, body: RequestTransferDto, senderEmail: string): Promise<TransferRecord> {
    await this.requireCurrentReview(context, body.sessionId, body.redactionReviewId);
    const transfer: TransferRecord = {
      id: uuidV7(), tenantId: context.tenantId, sessionId: body.sessionId,
      senderEmail, recipientEmail: body.recipientEmail, status: "pending", createdAt: new Date().toISOString(),
    };
    await this.store.saveTransfer(context, transfer);
    await this.store.createTransferOffer(context, { id: transfer.id, sessionId: transfer.sessionId, recipientEmail: transfer.recipientEmail });
    return transfer;
  }

  listTransfers(context: TenantContext): Promise<TransferRecord[]> {
    return this.store.listTransfers(context);
  }

  /** Resolves an active, unexpired share token to its grant and owning session. */
  private async resolveShareToken(token: string): Promise<{ grant: ShareTokenLookup; session: ArchivedSession }> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const grant = await this.store.getShareGrantByTokenHash(tokenHash);
    if (!grant || grant.status !== "active" || (grant.expiresAt && grant.expiresAt < new Date().toISOString())) {
      throw new NotFoundException("Share link not found");
    }
    const ownerContext: TenantContext = { tenantId: grant.tenantId, userId: grant.tenantId, scopes: ["archive:read"], authType: "machine" };
    const session = await this.store.getSession(ownerContext, grant.sessionId);
    if (!session) throw new NotFoundException("Share link not found");
    return { grant, session };
  }

  async consumeShare(token: string): Promise<Record<string, unknown>> {
    const { grant, session } = await this.resolveShareToken(token);
    const projected = applyRedactionProjection(structuredClone(session));
    return { session: canonicalProjection(projected), permission: grant.permission, expiresAt: grant.expiresAt };
  }

  async importShare(context: TenantContext, token: string): Promise<Record<string, unknown>> {
    const { grant, session } = await this.resolveShareToken(token);
    if (grant.permission !== "importer") throw new ForbiddenException("Share link does not allow import");
    const copy = copyTransferredSession(session, grant.grantId, context.userId, "share");
    await this.store.saveSession(context, copy);
    return sessionSummary(copy);
  }

  async declineTransfer(context: TenantContext, transferId: string): Promise<void> {
    try {
      await this.store.declineTransferOffer(context, transferId);
    } catch (error) {
      throw transferFailure(error);
    }
  }

  async acceptTransfer(context: TenantContext, transferId: string): Promise<Record<string, unknown>> {
    try {
      return sessionSummary(await this.store.acceptTransferOffer(context, transferId));
    } catch (error) {
      throw transferFailure(error);
    }
  }
}

/** Maps store-level transfer errors onto the contract's status codes. */
function transferFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  if (message === "transfer_not_found" || message === "transfer_session_missing") {
    return new NotFoundException("Pending transfer not found");
  }
  if (message === "transfer_not_addressed_to_caller") {
    return new ForbiddenException("Transfer is addressed to a different account");
  }
  return error instanceof Error ? error : new Error(message);
}
