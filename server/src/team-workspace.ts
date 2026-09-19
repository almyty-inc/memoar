import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode,
  Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Put, Query,
} from "@nestjs/common";
import type { ArchivedSession, MachineStore, TeamOptinStore, TeamShareOptinRecord, TeamStore, TenantContext } from "./archive-store.js";
import { Tenant } from "./auth.js";
import { RequireScopes } from "./auth/decorators.js";
import { uuidV7 } from "./ids.js";
import type { SearchFilters } from "./search/backends.js";
import { SearchQueryDto } from "./search/search.dto.js";
import { TeamSearchService } from "./search/team-search.js";
import { sessionChunk } from "./sessions.js";
import { TeamsService } from "./teams.js";
import { CreateTeamOptinDto } from "./team-workspace.dto.js";
import { ARCHIVE_STORE } from "./tokens.js";

/** The path segment standing for "every machine of this tenant". */
export const ALL_MACHINES = "all";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function optinBody(optin: TeamShareOptinRecord): Record<string, unknown> {
  return { teamId: optin.teamId, machineId: optin.machineId, createdAt: optin.createdAt };
}

/**
 * The team workspace: standing consent to share, and the reads it produces.
 *
 * A workspace is the team that already exists. Nothing here moves a session
 * between tenants or copies one — a member's sessions stay in the member's
 * tenant, under the member's own policy, for as long as they exist. What this
 * service does is record consent (`team_share_optins`), and read across the
 * tenants of accepted members, one tenant at a time.
 */
@Injectable()
export class TeamWorkspaceService {
  constructor(
    @Inject(ARCHIVE_STORE) private readonly store: TeamStore & TeamOptinStore & MachineStore,
    @Inject(TeamsService) private readonly teams: TeamsService,
    @Inject(TeamSearchService) private readonly search: TeamSearchService,
  ) {}

  async listOptins(context: TenantContext, teamId: string): Promise<{ items: Record<string, unknown>[] }> {
    await this.teams.requireMember(teamId, context.userId);
    const optins = await this.store.listTeamOptins(teamId, context.tenantId);
    return { items: optins.map(optinBody) };
  }

  /**
   * Enrols this tenant, or one of its machines, in a team.
   *
   * Three things are checked before a row lands, and each of them is somebody
   * else's archive if it is skipped: the caller is an accepted member of the
   * team; the machine, if named, is theirs; and this tenant is not already
   * enrolled somewhere else. The last one is not a policy preference —
   * `Visibility.teamId` is singular, so a tenant sharing into two teams would
   * have one field to say two things with.
   */
  async enrol(context: TenantContext, teamId: string, body: CreateTeamOptinDto): Promise<Record<string, unknown>> {
    await this.teams.requireMember(teamId, context.userId);
    const machineId = body.machineId ?? null;
    if (machineId && !await this.store.getMachine(context, machineId)) {
      throw new NotFoundException("No machine of this account with that id");
    }
    const existing = await this.store.listTenantOptins(context.tenantId);
    const elsewhere = existing.find((optin) => optin.teamId !== teamId);
    if (elsewhere) {
      throw new ConflictException({
        type: "https://memoar.dev/problems/team-optin-conflict",
        title: "This account already shares into another team",
        status: 409,
        code: "team_optin_conflict",
        teamId: elsewhere.teamId,
      });
    }
    const optin: TeamShareOptinRecord = {
      id: uuidV7(), teamId, tenantId: context.tenantId, userId: context.userId,
      machineId, createdAt: new Date().toISOString(),
    };
    // Enrolling twice is the same enrolment, so PUT is idempotent: the caller
    // gets back the consent that is in force either way.
    if (!await this.store.createTeamOptin(optin)) {
      const already = existing.find((row) => row.teamId === teamId && row.machineId === machineId);
      return optinBody(already ?? optin);
    }
    return optinBody(optin);
  }

  /**
   * Withdraws consent. Not retroactive unless asked: sessions already widened
   * keep the visibility they were written with, matching every other share in
   * this archive. `revokePast` walks the caller's own sessions — an ordinary
   * single-tenant write under their own policy — and puts them back to private.
   *
   * What it cannot reach: a teammate who has already imported a copy holds it in
   * *their* tenant. That copy is outside the sharer's reach permanently, and the
   * place to say so is the enrolment screen, not this one.
   */
  async revoke(context: TenantContext, teamId: string, machine: string, revokePast: boolean): Promise<Record<string, unknown>> {
    await this.teams.requireMember(teamId, context.userId);
    if (machine !== ALL_MACHINES && !UUID_PATTERN.test(machine)) {
      throw new BadRequestException(`machineId must be a uuid or "${ALL_MACHINES}"`);
    }
    const machineId = machine === ALL_MACHINES ? null : machine;
    const removed = await this.store.deleteTeamOptin(teamId, context.tenantId, machineId);
    if (!removed) throw new NotFoundException("No such enrolment");
    const revokedSessions = revokePast ? await this.store.revokeTeamVisibility(context, teamId, machineId) : 0;
    return { teamId, machineId, revokedSessions };
  }

  async searchTeam(
    context: TenantContext,
    teamId: string,
    query: string,
    mode: "hybrid" | "lexical" | "semantic" = "hybrid",
    filters: SearchFilters = {},
    limit = 30,
  ): Promise<Record<string, unknown>> {
    await this.teams.requireMember(teamId, context.userId);
    return this.search.response(teamId, await this.store.listTeamMemberTenants(teamId), query, mode, filters, limit);
  }

  /**
   * One teammate's session, or nothing. The single place that resolves a
   * session id across a team, so the HTTP route and the MCP tools cannot drift
   * into two different ideas of what a team member may read.
   */
  async readSession(context: TenantContext, teamId: string, sessionId: string): Promise<ArchivedSession> {
    await this.teams.requireMember(teamId, context.userId);
    const session = await this.store.getTeamSession(teamId, sessionId);
    // 404, not 403: whether a session a caller cannot see exists at all is not
    // theirs to learn, and a private teammate's session and a missing one are
    // the same answer here on purpose.
    if (!session) throw new NotFoundException("Session not found in this team");
    return session;
  }

  async getSession(context: TenantContext, teamId: string, sessionId: string, cursor?: string, chunkSize?: string): Promise<Record<string, unknown>> {
    return sessionChunk(await this.readSession(context, teamId, sessionId), cursor, chunkSize);
  }
}

@Controller("teams")
export class TeamWorkspaceController {
  constructor(private readonly workspace: TeamWorkspaceService) {}

  @Get(":teamId/optins")
  listOptins(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string) {
    return this.workspace.listOptins(context, teamId);
  }

  // Explicitly sharing:write. The guard infers scopes from the path, and
  // nothing under /teams matches a special branch, so a POST or PUT here would
  // be inferred as archive:write — which is the scope for writing your own
  // archive, not for deciding who else may read it.
  @Put(":teamId/optins")
  @HttpCode(200)
  @RequireScopes("sharing:write")
  enrol(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string, @Body() body: CreateTeamOptinDto) {
    return this.workspace.enrol(context, teamId, body);
  }

  @Delete(":teamId/optins/:machineId")
  @RequireScopes("sharing:write")
  revoke(
    @Tenant() context: TenantContext,
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("machineId") machineId: string,
    @Query("revokePast") revokePast?: string,
  ) {
    return this.workspace.revoke(context, teamId, machineId, revokePast === "true");
  }

  @Get(":teamId/search")
  searchTeam(@Tenant() context: TenantContext, @Param("teamId", ParseUUIDPipe) teamId: string, @Query() query: SearchQueryDto) {
    return this.workspace.searchTeam(context, teamId, query.q ?? "", query.mode ?? "hybrid", {
      ...(query.agent ? { agent: query.agent } : {}),
      ...(query.workspace ? { workspace: query.workspace } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
    }, query.limit ?? 30);
  }

  @Get(":teamId/sessions/:sessionId")
  getSession(
    @Tenant() context: TenantContext,
    @Param("teamId", ParseUUIDPipe) teamId: string,
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Query("cursor") cursor?: string,
    @Query("chunkSize") chunkSize?: string,
  ) {
    return this.workspace.getSession(context, teamId, sessionId, cursor, chunkSize);
  }
}
