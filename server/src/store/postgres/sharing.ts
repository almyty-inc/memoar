import { RedactionReviewEntity, ShareGrantEntity, ShareTokenEntity, TransferEntity, TransferOfferEntity, UserEntity } from "../../entities.js";
import type { ArchivedSession, TenantContext } from "../context.js";
import type { SharingStore } from "../interfaces.js";
import type { RedactionReviewRecord, ShareGrantRecord, ShareTokenLookup, TransferRecord } from "../records.js";
import { redactionPatterns, reviewedMasks } from "../../redaction.js";
import { sessionContentDigest } from "../review-digest.js";
import { copyTransferredSession } from "../transfer-copy.js";
import type { PostgresAnnotationStore } from "./annotations.js";
import type { PostgresSettingsStore } from "./settings.js";
import { TenantRunner } from "./runner.js";
import type { PostgresSessionStore } from "./sessions.js";

function reviewRecord(row: RedactionReviewEntity): RedactionReviewRecord {
  return {
    id: row.id, tenantId: row.tenantId, sessionId: row.sessionId, reviewerUserId: row.reviewerUserId,
    status: row.status, contentDigest: row.contentDigest, masks: row.masks ?? [],
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export class PostgresSharingStore implements SharingStore {
  constructor(
    private readonly runner: TenantRunner,
    private readonly sessions: PostgresSessionStore,
    private readonly settings: PostgresSettingsStore,
    private readonly annotations: PostgresAnnotationStore,
  ) {}

  async getReview(context: TenantContext, reviewId: string): Promise<RedactionReviewRecord | null> {
    return this.runner.inTenant(context, async (manager) => {
      const row = await manager.getRepository(RedactionReviewEntity).findOneBy({ id: reviewId, tenantId: context.tenantId });
      return row ? reviewRecord(row) : null;
    });
  }

  async getCurrentReview(context: TenantContext, sessionId: string, contentDigest: string): Promise<RedactionReviewRecord | null> {
    return this.runner.inTenant(context, async (manager) => {
      const row = await manager.getRepository(RedactionReviewEntity)
        .findOneBy({ tenantId: context.tenantId, sessionId, contentDigest, status: "completed" });
      return row ? reviewRecord(row) : null;
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

  /**
   * What this account sent, and what it was offered.
   *
   * The `transfers` table is under RLS and holds the sender's row only, so a
   * tenant-scoped read of it answers half the question the contract asks
   * ("Incoming and outgoing transfers") — and the half it left out is the half
   * with the buttons on it. A recipient saw nothing, so there was no id to
   * accept or decline in the app at all, and the in-memory store's single
   * shared table hid it by matching the recipient's address as well.
   *
   * The incoming half comes from `transfer_offers`, which is cross-tenant by
   * design and addressed by email.
   */
  async listTransfers(context: TenantContext): Promise<TransferRecord[]> {
    const sent = await this.runner.inTenant(context, async (manager) => (await manager.getRepository(TransferEntity).findBy({ tenantId: context.tenantId })).map((row) => ({
      ...row, createdAt: row.createdAt.toISOString(),
    })));
    const recipient = await this.runner.dataSource.getRepository(UserEntity).findOneBy({ id: context.userId });
    if (!recipient) return sent;
    const offers = await this.runner.dataSource.getRepository(TransferOfferEntity).findBy({ recipientEmail: recipient.email });
    const senderEmails = new Map<string, string>();
    const incoming: TransferRecord[] = [];
    for (const offer of offers) {
      if (offer.senderTenantId === context.tenantId) continue;
      if (!senderEmails.has(offer.senderUserId)) {
        const sender = await this.runner.dataSource.getRepository(UserEntity).findOneBy({ id: offer.senderUserId });
        senderEmails.set(offer.senderUserId, sender?.email ?? "");
      }
      incoming.push({
        id: offer.id, tenantId: offer.senderTenantId, sessionId: offer.sessionId,
        senderEmail: senderEmails.get(offer.senderUserId)!, recipientEmail: offer.recipientEmail,
        status: offer.status, createdAt: offer.createdAt.toISOString(),
      });
    }
    return [...sent, ...incoming];
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
  /**
   * Refuses a pending transfer. Nothing is copied, so the recipient never holds
   * the session; both sides are moved off "pending" so the offer stops showing
   * as awaiting an answer that will never come.
   */
  async declineTransferOffer(context: TenantContext, transferId: string): Promise<void> {
    const offerRepository = this.runner.dataSource.getRepository(TransferOfferEntity);
    const offer = await offerRepository.findOneBy({ id: transferId, status: "pending" });
    if (!offer) throw new Error("transfer_not_found");
    const recipient = await this.runner.dataSource.getRepository(UserEntity).findOneBy({ id: context.userId });
    if (!recipient || recipient.email.toLowerCase() !== offer.recipientEmail.toLowerCase()) {
      throw new Error("transfer_not_addressed_to_caller");
    }
    // Compare-and-swap, for the reason acceptTransferOffer does it: two callers
    // that both read the offer as pending must not both get to answer it.
    const declined = await offerRepository.update({ id: offer.id, status: "pending" }, { status: "declined" });
    if ((declined.affected ?? 0) === 0) throw new Error("transfer_not_found");
    const senderContext: TenantContext = {
      tenantId: offer.senderTenantId,
      userId: offer.senderUserId,
      scopes: ["archive:read"],
      authType: "machine",
    };
    await this.runner.inTenant(senderContext, async (manager) => {
      await manager.getRepository(TransferEntity).update(
        { id: offer.id, tenantId: offer.senderTenantId },
        { status: "declined" },
      );
    });
  }

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
    // Claimed before anything is read or copied. Two accepts of one offer used
    // to race through the pending read above and both write a copy, because the
    // status was only overwritten at the end; this update is the
    // compare-and-swap that makes exactly one of them the accepting one.
    const claimed = await offerRepository.update({ id: offer.id, status: "pending" }, { status: "accepted" });
    if ((claimed.affected ?? 0) === 0) throw new Error("transfer_not_found");
    let copy: ArchivedSession;
    try {
      const source = await this.sessions.getSession(senderContext, offer.sessionId);
      if (!source) throw new Error("transfer_session_missing");
      // The review that authorized the offer described the session as it was
      // then. An offer sits until the recipient acts on it, and the transcript
      // it names keeps growing in the meantime.
      if (!await this.getCurrentReview(senderContext, offer.sessionId, sessionContentDigest(source))) {
        throw new Error("transfer_review_stale");
      }
      // The sender completed a redaction review before offering this, so the
      // copy leaves their tenant through the same projection a share link uses.
      const [senderSettings, senderAnnotations] = await Promise.all([
        this.settings.getTenantSettings(senderContext),
        this.annotations.listAnnotations(senderContext, offer.sessionId),
      ]);
      copy = copyTransferredSession(source, offer.id, context.userId, "transfer", {
        patterns: redactionPatterns(senderSettings.redaction),
        masks: reviewedMasks(senderAnnotations),
      });
      await this.sessions.saveSession(context, copy);
    } catch (error) {
      // Nothing landed in the recipient's tenant, so the offer goes back to
      // pending rather than being spent on a copy that never happened — a
      // sender who reviews the session again must be able to have it accepted.
      // Past this point it stays accepted whatever fails: the recipient holds
      // the session, and a second accept would hand them a second copy.
      await offerRepository.update({ id: offer.id, status: "accepted" }, { status: "pending" });
      throw error;
    }
    await this.runner.inTenant(senderContext, async (manager) => {
      await manager.getRepository(TransferEntity).update(
        { id: offer.id, tenantId: offer.senderTenantId },
        { status: "accepted" },
      );
    });
    return copy;
  }
}
