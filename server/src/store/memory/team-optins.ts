/* eslint-disable @typescript-eslint/require-await -- in-memory store methods intentionally satisfy the asynchronous production port. */
import type { TenantContext } from "../context.js";
import type { TeamOptinStore } from "../interfaces.js";
import type { TeamShareOptinRecord } from "../records.js";
import { isTeamVisible } from "../team-visibility.js";
import { copy, key, type MemoryTables } from "./tables.js";

function optinKey(teamId: string, tenantId: string, machineId: string | null): string {
  return `${teamId}:${tenantId}:${machineId ?? "*"}`;
}

export class MemoryTeamOptinStore implements TeamOptinStore {
  constructor(private readonly tables: MemoryTables) {}

  async listTeamOptins(teamId: string, tenantId: string): Promise<TeamShareOptinRecord[]> {
    return [...this.tables.teamShareOptins.values()]
      .filter((optin) => optin.teamId === teamId && optin.tenantId === tenantId)
      .map((optin) => copy(optin));
  }

  async listTenantOptins(tenantId: string): Promise<TeamShareOptinRecord[]> {
    return [...this.tables.teamShareOptins.values()]
      .filter((optin) => optin.tenantId === tenantId)
      .map((optin) => copy(optin));
  }

  async createTeamOptin(optin: TeamShareOptinRecord): Promise<boolean> {
    const entry = optinKey(optin.teamId, optin.tenantId, optin.machineId);
    if (this.tables.teamShareOptins.has(entry)) return false;
    this.tables.teamShareOptins.set(entry, copy(optin));
    return true;
  }

  async deleteTeamOptin(teamId: string, tenantId: string, machineId: string | null): Promise<boolean> {
    return this.tables.teamShareOptins.delete(optinKey(teamId, tenantId, machineId));
  }

  /** Accepted membership, checked as the Postgres store's join checks it. */
  private stillAMember(optin: TeamShareOptinRecord): boolean {
    const members = this.tables.teamMembers.get(optin.teamId) ?? [];
    return members.some((member) => member.userId === optin.userId && member.status === "active");
  }

  /** First enrolment by creation time wins, matching the Postgres ordering. */
  async resolveIngestTeam(tenantId: string, machineId?: string): Promise<string | null> {
    const matches = [...this.tables.teamShareOptins.values()]
      .filter((optin) => optin.tenantId === tenantId)
      .filter((optin) => optin.machineId === null || (machineId !== undefined && optin.machineId === machineId))
      .filter((optin) => this.stillAMember(optin))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return matches[0]?.teamId ?? null;
  }

  async revokeTeamVisibility(context: TenantContext, teamId: string, machineId: string | null): Promise<number> {
    let reset = 0;
    for (const [entryKey, session] of this.tables.sessions) {
      if (!entryKey.startsWith(key(context.tenantId, ""))) continue;
      if (!isTeamVisible(session.visibility, teamId)) continue;
      if (machineId && session.source.machineId !== machineId) continue;
      session.visibility = { scope: "private", ownerId: session.visibility.ownerId };
      reset += 1;
    }
    return reset;
  }
}
