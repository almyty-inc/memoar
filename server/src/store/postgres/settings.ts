import { AccountSettingsEntity } from "../../entities.js";
import { uuidV7 } from "../../ids.js";
import type { TenantContext } from "../context.js";
import type { RetentionStore, SettingsStore } from "../interfaces.js";
import { DEFAULT_TENANT_SETTINGS, defaultDistillationSettings, type DistillationSettings, type TenantSettingsRecord } from "../records.js";
import { TenantRunner } from "./runner.js";

export class PostgresSettingsStore implements SettingsStore, RetentionStore {
  constructor(private readonly runner: TenantRunner) {}

  async getTenantSettings(context: TenantContext): Promise<TenantSettingsRecord> {
    return this.runner.inTenant(context, async (manager) => {
      const row = await manager.getRepository(AccountSettingsEntity).findOneBy({ tenantId: context.tenantId });
      return {
        redaction: (row?.redaction as TenantSettingsRecord["redaction"] | null | undefined) ?? structuredClone(DEFAULT_TENANT_SETTINGS.redaction),
        retention: (row?.retention as TenantSettingsRecord["retention"] | null | undefined) ?? structuredClone(DEFAULT_TENANT_SETTINGS.retention),
        updatedAt: row?.settingsUpdatedAt ? row.settingsUpdatedAt.toISOString() : null,
      };
    });
  }

  async saveTenantSettings(context: TenantContext, settings: TenantSettingsRecord): Promise<void> {
    await this.runner.inTenant(context, async (manager) => {
      const repository = manager.getRepository(AccountSettingsEntity);
      const existing = await repository.findOneBy({ tenantId: context.tenantId });
      await repository.save({
        id: existing?.id ?? uuidV7(),
        tenantId: context.tenantId,
        redaction: settings.redaction as unknown as Record<string, unknown>,
        retention: settings.retention as unknown as Record<string, unknown>,
        settingsUpdatedAt: settings.updatedAt ? new Date(settings.updatedAt) : new Date(),
      });
    });
  }

  async getDistillationSettings(context: TenantContext): Promise<DistillationSettings> {
    return this.runner.inTenant(context, async (manager) => {
      const row = await manager.getRepository(AccountSettingsEntity).findOneBy({ tenantId: context.tenantId });
      return row ? {
        enabled: row.distillationEnabled,
        provider: (row.distillationProvider ?? "none") as DistillationSettings["provider"],
        model: row.distillationModel ?? null,
        sealedApiKey: row.distillationApiKey ?? null,
        monthlyBudgetCents: row.monthlyDistillationBudgetCents,
        monthlySpentCents: row.monthlyDistillationSpentCents,
        budgetWindowStartedAt: row.budgetWindowStartedAt?.toISOString() ?? new Date().toISOString(),
      } : defaultDistillationSettings();
    });
  }

  async saveDistillationSettings(context: TenantContext, settings: DistillationSettings): Promise<void> {
    await this.runner.inTenant(context, async (manager) => {
      const repository = manager.getRepository(AccountSettingsEntity);
      const existing = await repository.findOneBy({ tenantId: context.tenantId });
      await repository.save({
        id: existing?.id ?? uuidV7(),
        tenantId: context.tenantId,
        distillationEnabled: settings.enabled,
        distillationProvider: settings.provider,
        distillationModel: settings.model,
        distillationApiKey: settings.sealedApiKey,
        monthlyDistillationBudgetCents: settings.monthlyBudgetCents,
        monthlyDistillationSpentCents: settings.monthlySpentCents,
        budgetWindowStartedAt: new Date(settings.budgetWindowStartedAt),
      });
    });
  }

  async reserveDistillationBudget(context: TenantContext, costCents: number): Promise<{ reserved: boolean; remainingCents: number }> {
    return this.runner.inTenant(context, async (manager) => {
      await manager.query(
        `UPDATE account_settings
         SET "monthlyDistillationSpentCents" = 0, "budgetWindowStartedAt" = now()
         WHERE "tenantId" = $1
           AND ("budgetWindowStartedAt" IS NULL OR "budgetWindowStartedAt" < now() - interval '30 days')`,
        [context.tenantId],
      );
      const rows = await manager.query(
        `UPDATE account_settings
         SET "monthlyDistillationSpentCents" = "monthlyDistillationSpentCents" + $2
         WHERE "tenantId" = $1
           AND "distillationEnabled"
           AND "monthlyDistillationSpentCents" + $2 <= "monthlyDistillationBudgetCents"
         RETURNING "monthlyDistillationBudgetCents" - "monthlyDistillationSpentCents" AS remaining`,
        [context.tenantId, costCents],
      ) as unknown as [{ remaining: number | string }[], number];
      const updated = rows[0];
      if (updated.length) return { reserved: true, remainingCents: Number(updated[0]!.remaining) };
      const current = await manager.getRepository(AccountSettingsEntity).findOneBy({ tenantId: context.tenantId });
      return {
        reserved: false,
        remainingCents: current ? Math.max(0, current.monthlyDistillationBudgetCents - current.monthlyDistillationSpentCents) : 0,
      };
    });
  }

  async settleDistillationSpend(context: TenantContext, deltaCents: number): Promise<void> {
    await this.runner.inTenant(context, async (manager) => {
      await manager.query(
        `UPDATE account_settings
         SET "monthlyDistillationSpentCents" = GREATEST(0, "monthlyDistillationSpentCents" + $2)
         WHERE "tenantId" = $1`,
        [context.tenantId, deltaCents],
      );
    });
  }

  async listTenantIds(): Promise<string[]> {
    const raw: unknown = await this.runner.dataSource.query(`SELECT DISTINCT "tenantId" FROM auth_identities`);
    return (raw as { tenantId: string }[]).map((row) => row.tenantId);
  }

  async applyRetention(context: TenantContext, cutoffIso: string, exemptCollected: boolean): Promise<{ deletedSessions: number; deletedArtifacts: number }> {
    return this.runner.inTenant(context, async (manager) => {
      const exemptClause = exemptCollected
        ? `AND id NOT IN (SELECT "sessionId" FROM collection_sessions WHERE "tenantId" = $1)`
        : "";
      const deletedRaw = await manager.query(
        `DELETE FROM sessions WHERE "tenantId" = $1 AND "capturedUpdatedAt" < $2 ${exemptClause} RETURNING id`,
        [context.tenantId, cutoffIso],
      ) as unknown as [{ id: string }[], number];
      const deletedSessionIds = deletedRaw[0].map((row) => row.id);
      if (deletedSessionIds.length === 0) return { deletedSessions: 0, deletedArtifacts: 0 };
      /*
        Only what this sweep's own deletes left behind.

        `artifact_sessions` has no foreign key to `sessions` and `deleteSession`
        leaves the join row in place, so "every join fails to resolve to a live
        session" is also true of an artifact whose session someone deleted by
        hand a minute ago. Bounded by the cutoff, that artifact is retained; this
        statement used to destroy it anyway and count it as retention's doing.
        The bytes are kept on purpose — a parser written later can still read
        them — so the artifact goes only when retention took every session it
        produced. The memory store has always scoped it this way.
      */
      const artifactsRaw = await manager.query(
        `DELETE FROM raw_artifacts r WHERE r."tenantId" = $1
           AND EXISTS (SELECT 1 FROM artifact_sessions j WHERE j."tenantId" = $1 AND j."artifactId" = r.id)
           AND NOT EXISTS (
             SELECT 1 FROM artifact_sessions j
             WHERE j."tenantId" = $1 AND j."artifactId" = r.id
               AND NOT (j."sessionId" = ANY($2::uuid[]))
           )
         RETURNING r.id`,
        [context.tenantId, deletedSessionIds],
      ) as unknown as [{ id: string }[], number];
      // Every join of a deleted artifact points at a session this sweep took,
      // so pruning by session id clears those rows and the surviving artifacts'
      // stale halves in one statement.
      await manager.query(
        `DELETE FROM artifact_sessions WHERE "tenantId" = $1 AND "sessionId" = ANY($2::uuid[])`,
        [context.tenantId, deletedSessionIds],
      );
      return { deletedSessions: deletedSessionIds.length, deletedArtifacts: artifactsRaw[0].length };
    });
  }
}
