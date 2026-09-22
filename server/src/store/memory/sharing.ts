/* eslint-disable @typescript-eslint/require-await -- in-memory store methods intentionally satisfy the asynchronous production port. */
import type { ArchivedSession, TenantContext } from "../context.js";
import type { DirectoryStore, SharingStore, TeamStore } from "../interfaces.js";
import type { CollectionRecord, RedactionReviewRecord, ShareGrantRecord, ShareTokenLookup, TeamInvitation, TeamMember, TeamMemberSummary, TeamRecord, TransferRecord } from "../records.js";
import { redactionPatterns, reviewedMasks } from "../../redaction.js";
import { sessionContentDigest } from "../review-digest.js";
import { copyTransferredSession } from "../transfer-copy.js";
import { uuidV7 } from "../../ids.js";
import { isTeamVisible } from "../team-visibility.js";
import { copy, key, type MemoryTables } from "./tables.js";

export class MemorySharingStore implements SharingStore {
  constructor(private readonly tables: MemoryTables) {}

  async getReview(context: TenantContext, reviewId: string): Promise<RedactionReviewRecord | null> {
    const review = this.tables.reviews.get(key(context.tenantId, reviewId));
    return review ? copy(review) : null;
  }

  /**
   * Only the addressee may accept or decline. The Postgres store has always
   * enforced this by looking the caller's email up; this store enforced nothing,
   * so anyone could act on anyone's transfer.
   */
  private assertAddressedTo(context: TenantContext, recipientEmail: string): void {
    if (!this.addressesFor(context).has(recipientEmail.trim().toLowerCase())) {
      throw new Error("transfer_not_addressed_to_caller");
    }
  }

  async getCurrentReview(context: TenantContext, sessionId: string, contentDigest: string): Promise<RedactionReviewRecord | null> {
    for (const review of this.tables.reviews.values()) {
      if (review.tenantId !== context.tenantId || review.sessionId !== sessionId) continue;
      if (review.status !== "completed" || review.contentDigest !== contentDigest) continue;
      return copy(review);
    }
    return null;
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

  /**
   * Every address this caller answers to.
   *
   * The dev convention `<userId>@local.invalid` was the only one this store
   * knew, so a transfer addressed to the account's real email — which is what
   * the Postgres store matches on, and what `seedAccount` gives a contract test
   * — was neither listed nor acceptable here. The two stores then disagreed
   * about who a transfer was for, which is the one thing this pair is meant to
   * agree on.
   */
  private addressesFor(context: TenantContext): Set<string> {
    const addresses = new Set([`${context.userId}@local.invalid`.toLowerCase()]);
    for (const [email, account] of this.tables.accountsByEmail) {
      if (account.userId === context.userId) addresses.add(email.trim().toLowerCase());
    }
    return addresses;
  }

  async listTransfers(context: TenantContext): Promise<TransferRecord[]> {
    const addresses = this.addressesFor(context);
    return [...this.tables.transfers.values()]
      .filter((item) => item.tenantId === context.tenantId || addresses.has(item.recipientEmail.toLowerCase()))
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
    this.assertAddressedTo(context, offer.recipientEmail);
    offer.status = "declined";
    const transfer = this.tables.transfers.get(key(offer.senderTenantId, transferId));
    if (transfer) transfer.status = "declined";
  }

  async acceptTransferOffer(context: TenantContext, transferId: string): Promise<ArchivedSession> {
    const offer = this.tables.transferOffers.get(transferId);
    if (!offer || offer.status !== "pending") throw new Error("transfer_not_found");
    this.assertAddressedTo(context, offer.recipientEmail);
    // Claimed before the first await, so a second accept of the same offer
    // finds it spent rather than interleaving with this one and writing the
    // recipient a second copy. Restored below if nothing is copied.
    offer.status = "accepted";
    const copied = await this.copyOffered(context, offer).catch((error: unknown) => {
      offer.status = "pending";
      throw error;
    });
    this.tables.sessions.set(key(context.tenantId, copied.id), copy(copied));
    const transfer = this.tables.transfers.get(key(offer.senderTenantId, transferId));
    if (transfer) transfer.status = "accepted";
    return copied;
  }

  private async copyOffered(context: TenantContext, offer: { id: string; senderTenantId: string; senderUserId: string; sessionId: string }): Promise<ArchivedSession> {
    const source = this.tables.sessions.get(key(offer.senderTenantId, offer.sessionId));
    if (!source) throw new Error("transfer_session_missing");
    // The review that authorized the offer described the session as it was
    // then, and an offer sits until the recipient acts on it.
    const senderContext: TenantContext = { ...context, tenantId: offer.senderTenantId, userId: offer.senderUserId };
    if (!await this.getCurrentReview(senderContext, offer.sessionId, sessionContentDigest(source))) {
      throw new Error("transfer_review_stale");
    }
    // The sender completed a redaction review before offering this. Copying it
    // without applying what that review masked would make the review a
    // formality on the transfer path exactly as it was on the share path.
    return copyTransferredSession(copy(source), offer.id, context.userId, "transfer", {
      patterns: redactionPatterns(this.tables.tenantSettings.get(offer.senderTenantId)?.redaction),
      masks: reviewedMasks([...this.tables.annotations.values()]
        .filter((annotation) => annotation.tenantId === offer.senderTenantId && annotation.sessionId === offer.sessionId)),
    });
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

  async listTeamMembers(teamId: string): Promise<TeamMemberSummary[]> {
    return (this.tables.teamMembers.get(teamId) ?? [])
      .map(({ userId, email, status }) => ({ userId, email, status }));
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

  async listTeamMemberTenants(teamId: string): Promise<string[]> {
    const members = this.tables.teamMembers.get(teamId) ?? [];
    return [...new Set(members.filter((member) => member.status === "active").map((member) => member.tenantId))];
  }

  /**
   * Fans out over accepted members' tenants, exactly as the Postgres store
   * does. It used to sweep every session in the table regardless of whose
   * tenant it was in, which passed the same tests while modelling none of the
   * boundary the real store depends on.
   */
  async listTeamSessions(teamId: string): Promise<ArchivedSession[]> {
    const tenants = new Set(await this.listTeamMemberTenants(teamId));
    return [...this.tables.sessions.entries()]
      .filter(([entryKey]) => tenants.has(entryKey.slice(0, entryKey.indexOf(":"))))
      .map(([, session]) => session)
      .filter((session) => isTeamVisible(session.visibility, teamId))
      .map((session) => copy(session));
  }

  async getTeamSession(teamId: string, sessionId: string): Promise<ArchivedSession | null> {
    for (const tenantId of await this.listTeamMemberTenants(teamId)) {
      const session = this.tables.sessions.get(key(tenantId, sessionId));
      if (session && isTeamVisible(session.visibility, teamId)) return copy(session);
    }
    return null;
  }

  async listTeamCollections(teamId: string): Promise<CollectionRecord[]> {
    return [...this.tables.collections.values()].filter((collection) => collection.teamId === teamId).map((collection) => copy(collection));
  }
}

