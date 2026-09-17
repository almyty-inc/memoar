/* eslint-disable @typescript-eslint/require-await -- in-memory store methods intentionally satisfy the asynchronous production port. */
import type { ArchivedSession, TenantContext } from "../context.js";
import type { DirectoryStore, SharingStore, TeamStore } from "../interfaces.js";
import type { CollectionRecord, RedactionReviewRecord, ShareGrantRecord, ShareTokenLookup, TeamInvitation, TeamMember, TeamRecord, TransferRecord } from "../records.js";
import { redactionPatterns, reviewedMasks } from "../../redaction.js";
import { copyTransferredSession } from "../transfer-copy.js";
import { uuidV7 } from "../../ids.js";
import { copy, key, type MemoryTables } from "./tables.js";

export class MemorySharingStore implements SharingStore {
  constructor(private readonly tables: MemoryTables) {}

  async getReview(context: TenantContext, reviewId: string): Promise<RedactionReviewRecord | null> {
    const review = this.tables.reviews.get(key(context.tenantId, reviewId));
    return review ? copy(review) : null;
  }

  async saveReview(context: TenantContext, review: RedactionReviewRecord): Promise<void> {
    if (review.tenantId !== context.tenantId) throw new Error("tenant_mismatch");
    this.tables.reviews.set(key(context.tenantId, review.id), copy(review));
  }

  async listShareGrants(context: TenantContext): Promise<ShareGrantRecord[]> {
    return [...this.tables.grants.values()].filter((item) => item.tenantId === context.tenantId).map(copy);
  }

  async saveShareGrant(context: TenantContext, grant: ShareGrantRecord): Promise<void> {
    if (grant.tenantId !== context.tenantId) throw new Error("tenant_mismatch");
    this.tables.grants.set(key(context.tenantId, grant.id), copy(grant));
  }

  async getShareGrantByTokenHash(tokenHash: string): Promise<ShareTokenLookup | null> {
    for (const grant of this.tables.grants.values()) {
      if (grant.tokenHash !== tokenHash) continue;
      return {
        grantId: grant.id, tenantId: grant.tenantId, sessionId: grant.sessionId,
        permission: grant.permission, status: grant.status, expiresAt: grant.expiresAt,
      };
    }
    return null;
  }

  async saveTransfer(context: TenantContext, transfer: TransferRecord): Promise<void> {
    if (transfer.tenantId !== context.tenantId) throw new Error("tenant_mismatch");
    this.tables.transfers.set(key(context.tenantId, transfer.id), copy(transfer));
  }

  async listTransfers(context: TenantContext): Promise<TransferRecord[]> {
    return [...this.tables.transfers.values()]
      .filter((item) => item.tenantId === context.tenantId || item.recipientEmail === `${context.userId}@local.invalid`)
      .map(copy);
  }

  async getTransfer(context: TenantContext, transferId: string): Promise<TransferRecord | null> {
    const transfer = this.tables.transfers.get(key(context.tenantId, transferId));
    return transfer ? copy(transfer) : null;
  }

  async createTransferOffer(context: TenantContext, offer: { id: string; sessionId: string; recipientEmail: string }): Promise<void> {
    this.tables.transferOffers.set(offer.id, {
      id: offer.id,
      senderTenantId: context.tenantId,
      senderUserId: context.userId,
      sessionId: offer.sessionId,
      recipientEmail: offer.recipientEmail,
      status: "pending",
    });
  }

  async declineTransferOffer(context: TenantContext, transferId: string): Promise<void> {
    const offer = this.tables.transferOffers.get(transferId);
    if (!offer || offer.status !== "pending") throw new Error("transfer_not_found");
    assertAddressedTo(context, offer.recipientEmail);
    offer.status = "declined";
    const transfer = this.tables.transfers.get(key(offer.senderTenantId, transferId));
    if (transfer) transfer.status = "declined";
  }

  async acceptTransferOffer(context: TenantContext, transferId: string): Promise<ArchivedSession> {
    const offer = this.tables.transferOffers.get(transferId);
    if (!offer || offer.status !== "pending") throw new Error("transfer_not_found");
    assertAddressedTo(context, offer.recipientEmail);
    const source = this.tables.sessions.get(key(offer.senderTenantId, offer.sessionId));
    if (!source) throw new Error("transfer_session_missing");
    // The sender completed a redaction review before offering this. Copying it
    // without applying what that review masked would make the review a
    // formality on the transfer path exactly as it was on the share path.
    const copied = copyTransferredSession(copy(source), offer.id, context.userId, "transfer", {
      patterns: redactionPatterns(this.tables.tenantSettings.get(offer.senderTenantId)?.redaction),
      masks: reviewedMasks([...this.tables.annotations.values()]
        .filter((annotation) => annotation.tenantId === offer.senderTenantId && annotation.sessionId === offer.sessionId)),
    });
    this.tables.sessions.set(key(context.tenantId, copied.id), copy(copied));
    offer.status = "accepted";
    const transfer = this.tables.transfers.get(key(offer.senderTenantId, transferId));
    if (transfer) transfer.status = "accepted";
    return copied;
  }
}

export class MemoryTeamStore implements TeamStore, DirectoryStore {
  constructor(private readonly tables: MemoryTables) {}

  async createTeam(input: { name: string; orgId?: string }, creator: TeamMember): Promise<TeamRecord> {
    const team = { id: uuidV7(), orgId: input.orgId ?? uuidV7(), name: input.name };
    this.tables.teams.set(team.id, team);
    this.tables.teamMembers.set(team.id, [{ ...copy(creator), status: "active" }]);
    return { ...team, memberCount: 1 };
  }

  async listTeamsForUser(userId: string): Promise<TeamRecord[]> {
    const result: TeamRecord[] = [];
    for (const team of this.tables.teams.values()) {
      const members = this.tables.teamMembers.get(team.id) ?? [];
      if (members.some((member) => member.userId === userId && member.status === "active")) {
        result.push({ ...team, memberCount: members.filter((member) => member.status === "active").length });
      }
    }
    return result;
  }

  async isTeamMember(teamId: string, userId: string): Promise<boolean> {
    return (this.tables.teamMembers.get(teamId) ?? []).some((member) => member.userId === userId && member.status === "active");
  }

  async inviteTeamMember(teamId: string, member: TeamMember): Promise<void> {
    if (!this.tables.teams.has(teamId)) throw new Error("team_not_found");
    const members = this.tables.teamMembers.get(teamId) ?? [];
    if (!members.some((existing) => existing.userId === member.userId)) members.push({ ...copy(member), status: "invited" });
    this.tables.teamMembers.set(teamId, members);
  }

  async listTeamInvitations(userId: string): Promise<TeamInvitation[]> {
    const invitations: TeamInvitation[] = [];
    for (const team of this.tables.teams.values()) {
      const members = this.tables.teamMembers.get(team.id) ?? [];
      if (members.some((member) => member.userId === userId && member.status === "invited")) {
        invitations.push({ teamId: team.id, teamName: team.name, orgId: team.orgId });
      }
    }
    return invitations;
  }

  async acceptTeamInvitation(teamId: string, userId: string): Promise<boolean> {
    const pending = (this.tables.teamMembers.get(teamId) ?? [])
      .find((member) => member.userId === userId && member.status === "invited");
    if (!pending) return false;
    pending.status = "active";
    return true;
  }

  async removeTeamMember(teamId: string, userId: string): Promise<boolean> {
    const members = this.tables.teamMembers.get(teamId) ?? [];
    const remaining = members.filter((member) => member.userId !== userId);
    this.tables.teamMembers.set(teamId, remaining);
    return remaining.length !== members.length;
  }

  async findAccountByEmail(email: string): Promise<TeamMember | null> {
    return this.tables.accountsByEmail.get(email.trim().toLowerCase()) ?? null;
  }

  async getAccountEmail(userId: string): Promise<string | null> {
    for (const [email, account] of this.tables.accountsByEmail) {
      if (account.userId === userId) return email;
    }
    return null;
  }

  async listTeamSessions(teamId: string): Promise<ArchivedSession[]> {
    return [...this.tables.sessions.values()]
      .filter((session) => session.visibility.scope === "team" && session.visibility.teamId === teamId)
      .map((session) => copy(session));
  }

  async listTeamCollections(teamId: string): Promise<CollectionRecord[]> {
    return [...this.tables.collections.values()].filter((collection) => collection.teamId === teamId).map((collection) => copy(collection));
  }
}

/**
 * Only the addressee may accept or decline. The Postgres store has always
 * enforced this by looking the caller's email up; this store enforced nothing,
 * so anyone could act on anyone's transfer. Dev identities are addressed by the
 * same `<userId>@local.invalid` convention listTransfers already uses.
 */
function assertAddressedTo(context: TenantContext, recipientEmail: string): void {
  if (recipientEmail.toLowerCase() !== `${context.userId}@local.invalid`.toLowerCase()) {
    throw new Error("transfer_not_addressed_to_caller");
  }
}
