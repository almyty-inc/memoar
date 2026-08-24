import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import type { DirectoryStore, TeamStore, TenantContext } from "./archive-store.js";
import { Tenant } from "./auth.js";
import { sessionSummary } from "./sessions.js";
import { AddTeamMemberDto, CreateTeamDto } from "./teams.dto.js";
import { ARCHIVE_STORE } from "./tokens.js";

@Injectable()
export class TeamsService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: TeamStore & DirectoryStore) {}

  private async requireMember(teamId: string, userId: string): Promise<void> {
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

  async addMember(context: TenantContext, teamId: string, email: string): Promise<void> {
    await this.requireMember(teamId, context.userId);
    const account = await this.store.findAccountByEmail(email);
    if (!account) throw new NotFoundException("No account with that email");
    await this.store.addTeamMember(teamId, account);
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

  @Put(":teamId/members")
  @HttpCode(204)
  addMember(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string, @Body() body: AddTeamMemberDto) {
    return this.teams.addMember(context, teamId, body.email);
  }

  @Delete(":teamId/members/:userId")
  @HttpCode(204)
  removeMember(@Tenant() context: TenantContext, @Param("teamId") teamId: string, @Param("userId") userId: string) {
    return this.teams.removeMember(context, teamId, userId);
  }

  @Get(":teamId/sessions")
  listSessions(@Tenant() context: TenantContext, @Param("teamId") teamId: string) {
    return this.teams.listSessions(context, teamId);
  }

  @Get(":teamId/collections")
  listCollections(@Tenant() context: TenantContext, @Param("teamId") teamId: string) {
    return this.teams.listCollections(context, teamId);
  }
}
