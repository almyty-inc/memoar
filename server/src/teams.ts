import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import type { DirectoryStore, TeamInvitation, TeamMemberSummary, TeamStore, TenantContext } from "./archive-store.js";
import { Tenant } from "./auth.js";
import { sessionSummary } from "./sessions.js";
import { RequireScopes } from "./auth/decorators.js";
import { AddTeamMemberDto, CreateTeamDto } from "./teams.dto.js";
import { ARCHIVE_STORE } from "./tokens.js";

@Injectable()
export class TeamsService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: TeamStore & DirectoryStore) {}

  /**
   * Public because the team workspace routes live in their own controller and
   * must gate on exactly this, not on a second copy of it. One membership check
   * for every team read there is.
   */
  async requireMember(teamId: string, userId: string): Promise<void> {
    if (!await this.store.isTeamMember(teamId, userId)) {
      throw new ForbiddenException("Caller is not a member of this team");
    }
  }

  async create(context: TenantContext, body: CreateTeamDto): Promise<Record<string, unknown>> {
    const email = await this.store.getAccountEmail(context.userId) ?? "";
    const team = await this.store.createTeam(
      { name: body.name, ...(body.orgId ? { orgId: body.orgId } : {}) },
      { userId: context.userId, tenantId: context.tenantId, email },
    );
    return { ...team };
  }

  async list(context: TenantContext): Promise<{ items: Record<string, unknown>[] }> {
    return { items: (await this.store.listTeamsForUser(context.userId)).map((team) => ({ ...team })) };
  }

  /**
   * Invites somebody. It takes effect when they accept, and not before.
   *
   * This used to add them outright: any member of any team could put any
   * address into any team, and team membership is how team-scoped sessions and
   * collections are read. Being added was a change to who could see your work,
   * made by somebody else, with nothing to agree to and nothing to refuse.
   */
  async invite(context: TenantContext, teamId: string, email: string): Promise<void> {
    await this.requireMember(teamId, context.userId);
    const account = await this.store.findAccountByEmail(email);
    if (!account) throw new NotFoundException("No account with that email");
    await this.store.inviteTeamMember(teamId, account);
  }

  /**
   * One team's roster: who is in it, and who has been asked and not answered.
   *
   * Membership-gated like every other team read, so it never tells an outsider
   * who is on a team. It is also the only place an invitation is visible to the
   * person who sent it — `memberCount` moves only on acceptance, and
   * `listInvitations` is scoped to the invitee by design.
   */
  async listMembers(context: TenantContext, teamId: string): Promise<{ items: TeamMemberSummary[] }> {
    await this.requireMember(teamId, context.userId);
    return { items: await this.store.listTeamMembers(teamId) };
  }

  /** The teams this person has been asked to join. Nobody sees anybody else's. */
  async listInvitations(context: TenantContext): Promise<{ items: TeamInvitation[] }> {
    return { items: await this.store.listTeamInvitations(context.userId) };
  }

  async acceptInvitation(context: TenantContext, teamId: string): Promise<void> {
    if (!await this.store.acceptTeamInvitation(teamId, context.userId)) {
      throw new NotFoundException("No pending invitation to that team");
    }
  }

  /** Refusing an invitation is removing one's own pending row. */
  async declineInvitation(context: TenantContext, teamId: string): Promise<void> {
    if (await this.store.isTeamMember(teamId, context.userId)) {
      throw new ConflictException("That invitation has already been accepted; leave the team instead");
    }
    if (!await this.store.removeTeamMember(teamId, context.userId)) {
      throw new NotFoundException("No pending invitation to that team");
    }
  }

  async removeMember(context: TenantContext, teamId: string, userId: string): Promise<void> {
    await this.requireMember(teamId, context.userId);
    if (!await this.store.removeTeamMember(teamId, userId)) throw new NotFoundException("Membership not found");
  }

  async listSessions(context: TenantContext, teamId: string): Promise<{ items: Record<string, unknown>[] }> {
    await this.requireMember(teamId, context.userId);
    return { items: (await this.store.listTeamSessions(teamId)).map(sessionSummary) };
  }

  async listCollections(context: TenantContext, teamId: string): Promise<{ items: Record<string, unknown>[] }> {
    await this.requireMember(teamId, context.userId);
    return { items: (await this.store.listTeamCollections(teamId)).map((collection) => ({
      id: collection.id,
      name: collection.name,
      ...(collection.description ? { description: collection.description } : {}),
      teamId: collection.teamId,
      sessionCount: collection.sessionIds.length,
      updatedAt: collection.updatedAt,
    })) };
  }
}

@Controller("teams")
export class TeamsController {
  constructor(@Inject(TeamsService) private readonly teams: TeamsService) {}

  @Get()
  list(@Tenant() context: TenantContext) {
    return this.teams.list(context);
  }

  @Post()
  @HttpCode(201)
  create(@Tenant() context: TenantContext, @Body() body: CreateTeamDto) {
    return this.teams.create(context, body);
  }

  @Get("invitations")
  listInvitations(@Tenant() context: TenantContext) {
    return this.teams.listInvitations(context);
  }

  @Post("invitations/:teamId/accept")
  @HttpCode(204)
  acceptInvitation(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string) {
    return this.teams.acceptInvitation(context, teamId);
  }

  @Delete("invitations/:teamId")
  @HttpCode(204)
  declineInvitation(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string) {
    return this.teams.declineInvitation(context, teamId);
  }

  // Inviting somebody into a team decides who may read the members' archives,
  // so it is a sharing act and asks for the sharing scope. The guard infers
  // scopes from the path and /teams matches no branch, so a PUT here was
  // inferred as archive:write — the scope for writing one's own archive.
  @Put(":teamId/members")
  @HttpCode(204)
  @RequireScopes("sharing:write")
  invite(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string, @Body() body: AddTeamMemberDto) {
    return this.teams.invite(context, teamId, body.email);
  }

  // Reading a roster is reading the team, so it is gated on membership exactly
  // as the sessions and collections routes below are. Placed after the PUT so
  // the two verbs on one path stay together.
  @Get(":teamId/members")
  listMembers(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string) {
    return this.teams.listMembers(context, teamId);
  }

  @Delete(":teamId/members/:userId")
  @HttpCode(204)
  removeMember(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.teams.removeMember(context, teamId, userId);
  }

  @Get(":teamId/sessions")
  listSessions(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string) {
    return this.teams.listSessions(context, teamId);
  }

  @Get(":teamId/collections")
  listCollections(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string) {
    return this.teams.listCollections(context, teamId);
  }
}
