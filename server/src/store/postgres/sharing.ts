import { RedactionReviewEntity, ShareGrantEntity, ShareTokenEntity, TransferEntity, TransferOfferEntity, UserEntity } from "../../entities.js";
import type { ArchivedSession, TenantContext } from "../context.js";
import type { SharingStore } from "../interfaces.js";
import type { RedactionReviewRecord, ShareGrantRecord, ShareTokenLookup, TransferRecord } from "../records.js";
import { copyTransferredSession } from "../transfer-copy.js";
import { TenantRunner } from "./runner.js";
import type { PostgresSessionStore } from "./sessions.js";

export class PostgresSharingStore implements SharingStore {
  constructor(private readonly runner: TenantRunner, private readonly sessions: PostgresSessionStore) {}

  async getReview(context: TenantContext, reviewId: string): Promise<RedactionReviewRecord | null> {
    return this.runner.inTenant(context, async (manager) => {
      const row = await manager.getRepository(RedactionReviewEntity).findOneBy({ id: reviewId, tenantId: context.tenantId });
      return row ? {
        id: row.id, tenantId: row.tenantId, sessionId: row.sessionId, reviewerUserId: row.reviewerUserId,
        status: row.status, contentDigest: row.contentDigest, masks: row.masks ?? [],
        completedAt: row.completedAt?.toISOString() ?? null,
      } : null;
    });
  }

  async saveReview(context: TenantContext, review: RedactionReviewRecord): Promise<void> {
    await this.runner.inTenant(context, async (manager) => { await manager.getRepository(RedactionReviewEntity).save({
      ...review, completedAt: review.completedAt ? new Date(review.completedAt) : null,
    }); });
  }

  async listShareGrants(context: TenantContext): Promise<ShareGrantRecord[]> {
    return this.runner.inTenant(context, async (manager) => (await manager.getRepository(ShareGrantEntity).findBy({ tenantId: context.tenantId })).map((row) => ({
      id: row.id, tenantId: row.tenantId, sessionId: row.sessionId, permission: row.permission,
      tokenHash: row.tokenHash, status: row.status, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt?.toISOString() ?? null,
    })));
  }

  async saveShareGrant(context: TenantContext, grant: ShareGrantRecord): Promise<void> {
    await this.runner.inTenant(context, async (manager) => { await manager.getRepository(ShareGrantEntity).save({
      ...grant, createdAt: new Date(grant.createdAt), expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null,
    }); });
    await this.runner.dataSource.getRepository(ShareTokenEntity).save({
      id: grant.id,
      tokenHash: grant.tokenHash,
      tenantId: grant.tenantId,
      sessionId: grant.sessionId,
      permission: grant.permission,
      status: grant.status,
      expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null,
    });
  }

  async getShareGrantByTokenHash(tokenHash: string): Promise<ShareTokenLookup | null> {
    const row = await this.runner.dataSource.getRepository(ShareTokenEntity).findOneBy({ tokenHash });
    if (!row) return null;
    return {
      grantId: row.id,
      tenantId: row.tenantId,
      sessionId: row.sessionId,
      permission: row.permission,
      status: row.status,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    };
  }

  async saveTransfer(context: TenantContext, transfer: TransferRecord): Promise<void> {
    await this.runner.inTenant(context, async (manager) => { await manager.getRepository(TransferEntity).save({
      ...transfer, createdAt: new Date(transfer.createdAt),
    }); });
  }

  async listTransfers(context: TenantContext): Promise<TransferRecord[]> {
    return this.runner.inTenant(context, async (manager) => (await manager.getRepository(TransferEntity).findBy({ tenantId: context.tenantId })).map((row) => ({
      ...row, createdAt: row.createdAt.toISOString(),
    })));
  }

  async getTransfer(context: TenantContext, transferId: string): Promise<TransferRecord | null> {
    return this.runner.inTenant(context, async (manager) => {
      const row = await manager.getRepository(TransferEntity).findOneBy({ id: transferId, tenantId: context.tenantId });
      return row ? { ...row, createdAt: row.createdAt.toISOString() } : null;
    });
  }

  async createTransferOffer(context: TenantContext, offer: { id: string; sessionId: string; recipientEmail: string }): Promise<void> {
    await this.runner.dataSource.getRepository(TransferOfferEntity).save({
      id: offer.id,
      senderTenantId: context.tenantId,
      senderUserId: context.userId,
      sessionId: offer.sessionId,
      recipientEmail: offer.recipientEmail,
      status: "pending",
    });
  }

  /**
   * Accepts a transfer as the addressed recipient: copies the canonical session
   * (with remapped turn/block ids and an import provenance entry) into the
   * caller's tenant, then marks the offer and the sender-side transfer accepted.
   */
  async acceptTransferOffer(context: TenantContext, transferId: string): Promise<ArchivedSession> {
    const offerRepository = this.runner.dataSource.getRepository(TransferOfferEntity);
    const offer = await offerRepository.findOneBy({ id: transferId, status: "pending" });
    if (!offer) throw new Error("transfer_not_found");
    const recipient = await this.runner.dataSource.getRepository(UserEntity).findOneBy({ id: context.userId });
    if (!recipient || recipient.email.toLowerCase() !== offer.recipientEmail.toLowerCase()) {
      throw new Error("transfer_not_addressed_to_caller");
    }
    const senderContext: TenantContext = {
      tenantId: offer.senderTenantId,
      userId: offer.senderUserId,
      scopes: ["archive:read"],
      authType: "machine",
    };
    const source = await this.sessions.getSession(senderContext, offer.sessionId);
    if (!source) throw new Error("transfer_session_missing");
    const copy = copyTransferredSession(source, offer.id, context.userId);
    await this.sessions.saveSession(context, copy);
    await offerRepository.update({ id: offer.id }, { status: "accepted" });
    await this.runner.inTenant(senderContext, async (manager) => {
      await manager.getRepository(TransferEntity).update(
        { id: offer.id, tenantId: offer.senderTenantId },
        { status: "accepted" },
      );
    });
    return copy;
  }
}
