import { MachineCommandEntity, MachineEntity } from "../../entities.js";
import { uuidV7 } from "../../ids.js";
import type { TenantContext } from "../context.js";
import type { MachineStore } from "../interfaces.js";
import type { MachineCommandRecord, MachineRecord } from "../records.js";
import { TenantRunner } from "./runner.js";

function toCommandRecord(row: MachineCommandEntity): MachineCommandRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    machineId: row.machineId,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    ackedAt: row.ackedAt ? row.ackedAt.toISOString() : null,
  };
}

export class PostgresMachineStore implements MachineStore {
  constructor(private readonly runner: TenantRunner) {}

  async listMachines(context: TenantContext): Promise<MachineRecord[]> {
    return this.runner.inTenant(context, async (manager) => (await manager.getRepository(MachineEntity).find({
      where: { tenantId: context.tenantId },
      order: { name: "ASC", id: "ASC" },
    })).map((row) => ({
      ...row,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    })));
  }

  async getMachine(context: TenantContext, machineId: string): Promise<MachineRecord | null> {
    return this.runner.inTenant(context, async (manager) => {
      const row = await manager.getRepository(MachineEntity).findOneBy({ id: machineId, tenantId: context.tenantId });
      return row ? { ...row, lastSeenAt: row.lastSeenAt?.toISOString() ?? null } : null;
    });
  }

  async saveMachine(context: TenantContext, machine: MachineRecord): Promise<void> {
    if (machine.tenantId !== context.tenantId) throw new Error("tenant_mismatch");
    await this.runner.inTenant(context, async (manager) => {
      await manager.getRepository(MachineEntity).save({
        ...machine,
        lastSeenAt: machine.lastSeenAt ? new Date(machine.lastSeenAt) : null,
      });
    });
  }

  async createMachineCommand(context: TenantContext, input: { machineId: string; kind: string; payload: Record<string, unknown> }): Promise<MachineCommandRecord> {
    return this.runner.inTenant(context, async (manager) => {
      const repository = manager.getRepository(MachineCommandEntity);
      const row = await repository.save(repository.create({
        id: uuidV7(), tenantId: context.tenantId, machineId: input.machineId, kind: input.kind,
        payload: input.payload, status: "pending", error: null, deliveredAt: null, ackedAt: null,
      }));
      return toCommandRecord(row);
    });
  }

  async listUnackedMachineCommands(context: TenantContext, machineId: string): Promise<MachineCommandRecord[]> {
    return this.runner.inTenant(context, async (manager) => {
      const rows = await manager.getRepository(MachineCommandEntity).find({
        where: [
          { tenantId: context.tenantId, machineId, status: "pending" },
          { tenantId: context.tenantId, machineId, status: "delivered" },
        ],
        order: { createdAt: "ASC" },
      });
      return rows.map(toCommandRecord);
    });
  }

  async markMachineCommandsDelivered(context: TenantContext, commandIds: readonly string[]): Promise<void> {
    if (commandIds.length === 0) return;
    await this.runner.inTenant(context, async (manager) => {
      await manager.query(
        `UPDATE machine_commands SET status = 'delivered', "deliveredAt" = now() WHERE "tenantId" = $1 AND status = 'pending' AND id = ANY($2::uuid[])`,
        [context.tenantId, [...commandIds]],
      );
    });
  }

  async ackMachineCommand(context: TenantContext, machineId: string, commandId: string, outcome: { status: "completed" | "failed"; error?: string }): Promise<boolean> {
    return this.runner.inTenant(context, async (manager) => {
      const result = await manager.getRepository(MachineCommandEntity).update(
        { tenantId: context.tenantId, machineId, id: commandId },
        { status: outcome.status, error: outcome.error ?? null, ackedAt: new Date() },
      );
      return (result.affected ?? 0) > 0;
    });
  }
}
