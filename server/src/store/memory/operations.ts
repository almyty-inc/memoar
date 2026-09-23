/* eslint-disable @typescript-eslint/require-await -- in-memory store methods intentionally satisfy the asynchronous production port. */
import { uuidV7 } from "../../ids.js";
import type { TenantContext } from "../context.js";
import type { ArtifactStore, JobStore, MachineStore, RetentionStore, SettingsStore } from "../interfaces.js";
import {
  DEFAULT_TENANT_SETTINGS,
  defaultDistillationSettings,
  type DistillationSettings,
  type JobRecord,
  type MachineCommandRecord,
  type MachineRecord,
  type RawArtifactRecord,
  type TenantSettingsRecord,
} from "../records.js";
import { copy, key, type MemoryTables } from "./tables.js";

export class MemoryArtifactStore implements ArtifactStore {
  constructor(private readonly tables: MemoryTables) {}

  async saveRawArtifact(context: TenantContext, artifact: RawArtifactRecord): Promise<boolean> {
    const entryKey = key(context.tenantId, artifact.sha256);
    if (this.tables.artifacts.has(entryKey)) return false;
    if (artifact.tenantId !== context.tenantId) throw new Error("tenant_mismatch");
    this.tables.artifacts.set(entryKey, copy(artifact));
    return true;
  }

  async updateRawArtifact(context: TenantContext, artifact: RawArtifactRecord): Promise<void> {
    if (artifact.tenantId !== context.tenantId) throw new Error("tenant_mismatch");
    this.tables.artifacts.set(key(context.tenantId, artifact.sha256), copy(artifact));
  }

  async getRawArtifact(context: TenantContext, sha256: string): Promise<RawArtifactRecord | null> {
    const artifact = this.tables.artifacts.get(key(context.tenantId, sha256));
    return artifact ? copy(artifact) : null;
  }

  async listArtifactHashes(context: TenantContext, hashes: readonly string[]): Promise<Set<string>> {
    return new Set(hashes.filter((hash) => this.tables.artifacts.has(key(context.tenantId, hash))));
  }

  async countUnparsedArtifactsBySource(context: TenantContext): Promise<{ source: string; artifacts: number; diagnostic: string | null }[]> {
    // The commonest reason, matching Postgres. This took whichever diagnostic
    // it happened to read last, which is a third answer again — the two stores
    // and the doctor check all described the same pile differently.
    const bySource = new Map<string, Map<string | null, number>>();
    for (const artifact of await this.listRawArtifacts(context)) {
      if (artifact.status !== "unknown_format" && artifact.status !== "failed") continue;
      const reasons = bySource.get(artifact.source) ?? new Map<string | null, number>();
      const reason = artifact.diagnostic ?? null;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      bySource.set(artifact.source, reasons);
    }
    return [...bySource.entries()]
      .map(([source, reasons]) => ({
        source,
        artifacts: [...reasons.values()].reduce((total, count) => total + count, 0),
        // Ties break by the reason itself, so the answer does not depend on
        // the order rows happened to arrive in.
        diagnostic: [...reasons.entries()].sort(
          (left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])),
        )[0]![0],
      }))
      .sort((left, right) => right.artifacts - left.artifacts);
  }

  async listRawArtifacts(context: TenantContext): Promise<RawArtifactRecord[]> {
    return [...this.tables.artifacts.entries()]
      .filter(([entryKey]) => entryKey.startsWith(`${context.tenantId}:`))
      .map(([, artifact]) => copy(artifact));
  }
}

export class MemoryJobStore implements JobStore {
  constructor(private readonly tables: MemoryTables) {}

  async saveJob(context: TenantContext, job: JobRecord): Promise<void> {
    if (job.tenantId !== context.tenantId) throw new Error("tenant_mismatch");
    this.tables.jobs.set(key(context.tenantId, job.id), copy(job));
  }

  async getJob(context: TenantContext, jobId: string): Promise<JobRecord | null> {
    const job = this.tables.jobs.get(key(context.tenantId, jobId));
    return job ? copy(job) : null;
  }
}

export class MemoryMachineStore implements MachineStore {
  constructor(private readonly tables: MemoryTables) {}

  private live(machine: MachineRecord): boolean {
    return !this.tables.retiredMachines.has(key(machine.tenantId, machine.id));
  }

  async listMachines(context: TenantContext): Promise<MachineRecord[]> {
    return [...this.tables.machines.values()]
      .filter((machine) => machine.tenantId === context.tenantId && this.live(machine))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map(copy);
  }

  async getMachine(context: TenantContext, machineId: string): Promise<MachineRecord | null> {
    const machine = this.tables.machines.get(key(context.tenantId, machineId));
    return machine && this.live(machine) ? copy(machine) : null;
  }

  async findMachineByInstallation(context: TenantContext, installationId: string): Promise<MachineRecord | null> {
    const machine = [...this.tables.machines.values()].find(
      (candidate) => candidate.tenantId === context.tenantId && candidate.installationId === installationId && this.live(candidate),
    );
    return machine ? copy(machine) : null;
  }

  async retireMachine(context: TenantContext, machineId: string): Promise<boolean> {
    const machine = this.tables.machines.get(key(context.tenantId, machineId));
    if (!machine || !this.live(machine)) return false;
    this.tables.retiredMachines.add(key(context.tenantId, machineId));
    return true;
  }

  async saveMachine(context: TenantContext, machine: MachineRecord): Promise<void> {
    if (machine.tenantId !== context.tenantId) throw new Error("tenant_mismatch");
    this.tables.machines.set(key(context.tenantId, machine.id), copy(machine));
  }

  async createMachineCommand(context: TenantContext, input: { machineId: string; kind: string; payload: Record<string, unknown> }): Promise<MachineCommandRecord> {
    const command: MachineCommandRecord = {
      id: uuidV7(), tenantId: context.tenantId, machineId: input.machineId, kind: input.kind,
      payload: copy(input.payload), status: "pending", error: null,
      createdAt: new Date().toISOString(), deliveredAt: null, ackedAt: null,
    };
    this.tables.machineCommands.set(key(context.tenantId, command.id), copy(command));
    return command;
  }

  async listUnackedMachineCommands(context: TenantContext, machineId: string): Promise<MachineCommandRecord[]> {
    return [...this.tables.machineCommands.values()]
      .filter((command) => command.tenantId === context.tenantId && command.machineId === machineId
        && (command.status === "pending" || command.status === "delivered"))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((command) => copy(command));
  }

  async markMachineCommandsDelivered(context: TenantContext, commandIds: readonly string[]): Promise<void> {
    for (const commandId of commandIds) {
      const command = this.tables.machineCommands.get(key(context.tenantId, commandId));
      if (command && command.status === "pending") {
        command.status = "delivered";
        command.deliveredAt = new Date().toISOString();
      }
    }
  }

  async ackMachineCommand(context: TenantContext, machineId: string, commandId: string, outcome: { status: "completed" | "failed"; error?: string }): Promise<boolean> {
    const command = this.tables.machineCommands.get(key(context.tenantId, commandId));
    if (!command || command.machineId !== machineId) return false;
    command.status = outcome.status;
    command.error = outcome.error ?? null;
    command.ackedAt = new Date().toISOString();
    return true;
  }
}

export class MemorySettingsStore implements SettingsStore, RetentionStore {
  constructor(private readonly tables: MemoryTables) {}

  async getTenantSettings(context: TenantContext): Promise<TenantSettingsRecord> {
    return copy(this.tables.tenantSettings.get(context.tenantId) ?? DEFAULT_TENANT_SETTINGS);
  }

  async saveTenantSettings(context: TenantContext, settings: TenantSettingsRecord): Promise<void> {
    this.tables.tenantSettings.set(context.tenantId, copy(settings));
  }

  async getDistillationSettings(context: TenantContext): Promise<DistillationSettings> {
    return copy(this.tables.distillation.get(context.tenantId) ?? defaultDistillationSettings());
  }

  async saveDistillationSettings(context: TenantContext, settings: DistillationSettings): Promise<void> {
    this.tables.distillation.set(context.tenantId, copy(settings));
  }

  async reserveDistillationBudget(context: TenantContext, costCents: number): Promise<{ reserved: boolean; remainingCents: number }> {
    const settings = await this.getDistillationSettings(context);
    if (new Date(settings.budgetWindowStartedAt).getTime() < Date.now() - 30 * 24 * 3600 * 1000) {
      settings.monthlySpentCents = 0;
      settings.budgetWindowStartedAt = new Date().toISOString();
    }
    if (!settings.enabled || settings.monthlySpentCents + costCents > settings.monthlyBudgetCents) {
      this.tables.distillation.set(context.tenantId, settings);
      return { reserved: false, remainingCents: Math.max(0, settings.monthlyBudgetCents - settings.monthlySpentCents) };
    }
    settings.monthlySpentCents += costCents;
    this.tables.distillation.set(context.tenantId, settings);
    /*
      What is left *after* this reservation, which is what Postgres returns from
      `RETURNING budget - spent` on the row it just charged. Returning the budget
      as it stood before meant every test saw a wider ceiling than production:
      the number becomes `maxTokens: min(4000, remaining * 400)` in the distiller,
      so the model was capped tighter live than anything under test ever was.
    */
    return { reserved: true, remainingCents: Math.max(0, settings.monthlyBudgetCents - settings.monthlySpentCents) };
  }

  async settleDistillationSpend(context: TenantContext, deltaCents: number): Promise<void> {
    const settings = await this.getDistillationSettings(context);
    settings.monthlySpentCents = Math.max(0, settings.monthlySpentCents + deltaCents);
    this.tables.distillation.set(context.tenantId, settings);
  }

  async listTenantIds(): Promise<string[]> {
    const tenants = new Set<string>(this.tables.tenantSettings.keys());
    for (const compound of this.tables.sessions.keys()) tenants.add(compound.slice(0, compound.indexOf(":")));
    return [...tenants];
  }

  async applyRetention(context: TenantContext, cutoffIso: string, exemptCollected: boolean): Promise<{ deletedSessions: number; deletedArtifacts: number }> {
    const collected = new Set<string>();
    if (exemptCollected) {
      for (const collection of this.tables.collections.values()) {
        if (collection.tenantId !== context.tenantId) continue;
        for (const sessionId of collection.sessionIds) collected.add(sessionId);
      }
    }
    const deleted = new Set<string>();
    for (const [compound, session] of this.tables.sessions) {
      if (!compound.startsWith(`${context.tenantId}:`)) continue;
      if (session.updatedAt >= cutoffIso || collected.has(session.id)) continue;
      this.tables.sessions.delete(compound);
      deleted.add(session.id);
    }
    let deletedArtifacts = 0;
    for (const [compound, artifact] of this.tables.artifacts) {
      if (artifact.tenantId !== context.tenantId || artifact.sessionIds.length === 0) continue;
      const remaining = artifact.sessionIds.filter((sessionId) => !deleted.has(sessionId));
      if (remaining.length === 0) {
        this.tables.artifacts.delete(compound);
        deletedArtifacts += 1;
      } else if (remaining.length !== artifact.sessionIds.length) {
        this.tables.artifacts.set(compound, { ...artifact, sessionIds: remaining });
      }
    }
    return { deletedSessions: deleted.size, deletedArtifacts };
  }
}
