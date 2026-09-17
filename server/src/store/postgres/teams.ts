import { AuthIdentityEntity, OrganizationEntity, TeamEntity, TeamMemberEntity, UserEntity } from "../../entities.js";
import { uuidV7 } from "../../ids.js";
import type { ArchivedSession, TenantContext } from "../context.js";
import type { DirectoryStore, TeamStore } from "../interfaces.js";
import type { CollectionRecord, TeamInvitation, TeamMember, TeamRecord } from "../records.js";
import type { PostgresCollectionStore } from "./collections.js";
import { TenantRunner } from "./runner.js";
import type { PostgresSessionStore } from "./sessions.js";

export class PostgresTeamStore implements TeamStore, DirectoryStore {
  constructor(
    private readonly runner: TenantRunner,
    private readonly sessions: PostgresSessionStore,
    private readonly collections: PostgresCollectionStore,
  ) {}

  private systemContext(tenantId: string): TenantContext {
    return { tenantId, userId: tenantId, scopes: ["archive:read"], authType: "machine" };
  }

  async createTeam(input: { name: string; orgId?: string }, creator: TeamMember): Promise<TeamRecord> {
    let orgId = input.orgId;
    if (!orgId) {
      orgId = uuidV7();
      await this.runner.dataSource.getRepository(OrganizationEntity).save({ id: orgId, name: input.name });
    }
    const team = { id: uuidV7(), orgId, name: input.name };
    await this.runner.dataSource.getRepository(TeamEntity).save(team);
    await this.runner.dataSource.getRepository(TeamMemberEntity).save({ id: uuidV7(), teamId: team.id, status: "active", ...creator });
    return { ...team, memberCount: 1 };
  }

  async listTeamsForUser(userId: string): Promise<TeamRecord[]> {
    const memberships = await this.runner.dataSource.getRepository(TeamMemberEntity).findBy({ userId, status: "active" });
    const result: TeamRecord[] = [];
    for (const membership of memberships) {
      const team = await this.runner.dataSource.getRepository(TeamEntity).findOneBy({ id: membership.teamId });
      if (!team) continue;
      const memberCount = await this.runner.dataSource.getRepository(TeamMemberEntity).countBy({ teamId: team.id, status: "active" });
      result.push({ id: team.id, orgId: team.orgId, name: team.name, memberCount });
    }
    return result;
  }

  async isTeamMember(teamId: string, userId: string): Promise<boolean> {
    return this.runner.dataSource.getRepository(TeamMemberEntity).existsBy({ teamId, userId, status: "active" });
  }

  async inviteTeamMember(teamId: string, member: TeamMember): Promise<void> {
    if (!await this.runner.dataSource.getRepository(TeamEntity).existsBy({ id: teamId })) throw new Error("team_not_found");
    const repository = this.runner.dataSource.getRepository(TeamMemberEntity);
    if (await repository.existsBy({ teamId, userId: member.userId })) return;
    await repository.save({ id: uuidV7(), teamId, status: "invited", ...member });
  }

  async listTeamInvitations(userId: string): Promise<TeamInvitation[]> {
    const pending = await this.runner.dataSource.getRepository(TeamMemberEntity).findBy({ userId, status: "invited" });
    const invitations: TeamInvitation[] = [];
    for (const membership of pending) {
      const team = await this.runner.dataSource.getRepository(TeamEntity).findOneBy({ id: membership.teamId });
      if (team) invitations.push({ teamId: team.id, teamName: team.name, orgId: team.orgId });
    }
    return invitations;
  }

  async acceptTeamInvitation(teamId: string, userId: string): Promise<boolean> {
    const result = await this.runner.dataSource.getRepository(TeamMemberEntity)
      .update({ teamId, userId, status: "invited" }, { status: "active" });
    return (result.affected ?? 0) > 0;
  }

  async removeTeamMember(teamId: string, userId: string): Promise<boolean> {
    const result = await this.runner.dataSource.getRepository(TeamMemberEntity).delete({ teamId, userId });
    return (result.affected ?? 0) > 0;
  }

  async findAccountByEmail(email: string): Promise<TeamMember | null> {
    const lookupKey = email.trim().toLowerCase();
    // Both ways a person can have an account. Asking only for a password
    // identity made anyone who had only ever signed in with a provider
    // invisible here, so they could not be added to a team at all.
    const identity = await this.runner.dataSource.getRepository(AuthIdentityEntity).findOne({
      where: [{ kind: "password", lookupKey }, { kind: "oauth", lookupKey }],
    });
    if (!identity) return null;
    return { userId: identity.userId, tenantId: identity.tenantId, email: lookupKey };
  }

  async getAccountEmail(userId: string): Promise<string | null> {
    const user = await this.runner.dataSource.getRepository(UserEntity).findOneBy({ id: userId });
    return user?.email ?? null;
  }

  private async memberTenants(teamId: string): Promise<string[]> {
    // Accepted members only: an invitation must not open anybody's archive.
    const rows = await this.runner.dataSource.getRepository(TeamMemberEntity).findBy({ teamId, status: "active" });
    return [...new Set(rows.map((row) => row.tenantId))];
  }

  async listTeamSessions(teamId: string): Promise<ArchivedSession[]> {
    const sessions: ArchivedSession[] = [];
    for (const tenantId of await this.memberTenants(teamId)) {
      const context = this.systemContext(tenantId);
      const ids = await this.runner.inTenant(context, async (manager) => {
        const raw: unknown = await manager.query(
          `SELECT id FROM sessions WHERE "tenantId" = $1 AND visibility->>'scope' = 'team' AND visibility->>'teamId' = $2`,
          [tenantId, teamId],
        );
        return raw as { id: string }[];
      });
      for (const row of ids) {
        const session = await this.sessions.getSession(context, row.id);
        if (session) sessions.push(session);
      }
    }
    return sessions;
  }

  async listTeamCollections(teamId: string): Promise<CollectionRecord[]> {
    const collections: CollectionRecord[] = [];
    for (const tenantId of await this.memberTenants(teamId)) {
      const rows = await this.collections.listCollections(this.systemContext(tenantId));
      collections.push(...rows.filter((collection) => collection.teamId === teamId));
    }
    return collections;
  }
}
