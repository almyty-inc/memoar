import { IsNull, type FindOptionsWhere } from "typeorm";
import { TeamShareOptinEntity } from "../../entities.js";
import type { TenantContext } from "../context.js";
import type { TeamOptinStore } from "../interfaces.js";
import type { TeamShareOptinRecord } from "../records.js";
import { teamVisibilitySql } from "../team-visibility.js";
import type { TenantRunner } from "./runner.js";

function record(row: TeamShareOptinEntity): TeamShareOptinRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    tenantId: row.tenantId,
    userId: row.userId,
    machineId: row.machineId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Consent rows. Not under RLS and deliberately so — this table says who has
 * agreed to share, never what they captured. Every read of actual session
 * content still happens inside `TenantRunner.inTenant`, under the single-valued
 * tenant setting the policies read.
 */
export class PostgresTeamOptinStore implements TeamOptinStore {
  constructor(private readonly runner: TenantRunner) {}

  private get repository() {
    return this.runner.dataSource.getRepository(TeamShareOptinEntity);
  }

  /** A null machineId means every machine, and SQL will not find it with `=`. */
  private static where(teamId: string, tenantId: string, machineId: string | null): FindOptionsWhere<TeamShareOptinEntity> {
    return { teamId, tenantId, machineId: machineId === null ? IsNull() : machineId };
  }

  async listTeamOptins(teamId: string, tenantId: string): Promise<TeamShareOptinRecord[]> {
    return (await this.repository.findBy({ teamId, tenantId })).map(record);
  }

  async listTenantOptins(tenantId: string): Promise<TeamShareOptinRecord[]> {
    return (await this.repository.findBy({ tenantId })).map(record);
  }

  async createTeamOptin(optin: TeamShareOptinRecord): Promise<boolean> {
    const existing = await this.repository.findOneBy(
      PostgresTeamOptinStore.where(optin.teamId, optin.tenantId, optin.machineId),
    );
    if (existing) return false;
    await this.repository.save({
      id: optin.id, teamId: optin.teamId, tenantId: optin.tenantId,
      userId: optin.userId, machineId: optin.machineId, createdAt: new Date(optin.createdAt),
    });
    return true;
  }

  async deleteTeamOptin(teamId: string, tenantId: string, machineId: string | null): Promise<boolean> {
    const result = await this.repository.delete(PostgresTeamOptinStore.where(teamId, tenantId, machineId));
    return (result.affected ?? 0) > 0;
  }

  /**
   * First enrolment by creation time wins. `Visibility.teamId` is singular, so
   * a session can name one team; enrolling a tenant in a second team is refused
   * at the API rather than resolved arbitrarily here.
   *
   * Joined against live, accepted membership rather than trusting the consent
   * row on its own. A consent that outlives the membership would keep stamping
   * captures for a team the person has left — invisible while they are out,
   * because their tenant is no longer in the fan-out, and retroactively
   * revealing every one of those sessions the day they rejoined.
   */
  async resolveIngestTeam(tenantId: string, machineId?: string): Promise<string | null> {
    const raw: unknown = await this.runner.dataSource.query(
      `SELECT o."teamId" FROM team_share_optins o
         JOIN team_members m ON m."teamId" = o."teamId" AND m."userId" = o."userId" AND m.status = 'active'
        WHERE o."tenantId" = $1 AND (o."machineId" IS NULL OR o."machineId" = $2)
        ORDER BY o."createdAt" ASC, o.id ASC
        LIMIT 1`,
      [tenantId, machineId ?? null],
    );
    return (raw as { teamId: string }[])[0]?.teamId ?? null;
  }

  async revokeTeamVisibility(context: TenantContext, teamId: string, machineId: string | null): Promise<number> {
    return this.runner.inTenant(context, async (manager) => {
      const values: unknown[] = [context.tenantId, teamId];
      const conditions = [`"tenantId" = $1`, teamVisibilitySql(2)];
      if (machineId) {
        values.push(machineId);
        conditions.push(`source ->> 'machineId' = $${values.length}`);
      }
      // Selected, then updated by id, rather than counted from the update.
      // TypeORM hands back `[rows, affected]` for a RETURNING update, so
      // `.length` on that is 2 whatever was written — which reported "2
      // sessions revoked" for one session, and would have reported it for none.
      const raw: unknown = await manager.query(`SELECT id FROM sessions WHERE ${conditions.join(" AND ")}`, values);
      const ids = (raw as { id: string }[]).map((row) => row.id);
      if (!ids.length) return 0;
      // The owner is kept: a session put back to private is still that person's
      // session, and dropping ownerId would orphan it from every other check
      // that asks who it belongs to.
      await manager.query(
        `UPDATE sessions
            SET visibility = jsonb_strip_nulls(jsonb_build_object('scope', 'private', 'ownerId', visibility->'ownerId'))
          WHERE "tenantId" = $1 AND id = ANY($2::uuid[])`,
        [context.tenantId, ids],
      );
      return ids.length;
    });
  }
}
