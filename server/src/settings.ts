import { BadRequestException, Body, Controller, Get, Inject, Injectable, Put } from "@nestjs/common";
import type { RedactionSettingsRecord, RetentionSettingsRecord, RetentionStore, SettingsStore, TenantContext, TenantSettingsRecord } from "./archive-store.js";
import { Tenant } from "./auth.js";
import { UpdateSettingsDto } from "./settings.dto.js";
import { ARCHIVE_STORE } from "./tokens.js";

function invalidSettings(detail: string): never {
  throw new BadRequestException({
    type: "https://memoar.dev/problems/invalid-settings",
    title: "Invalid settings",
    status: 400,
    code: "invalid_settings",
    detail,
  });
}

@Injectable()
export class SettingsService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: SettingsStore) {}

  get(context: TenantContext): Promise<TenantSettingsRecord> {
    return this.store.getTenantSettings(context);
  }

  async update(
    context: TenantContext,
    body: UpdateSettingsDto,
  ): Promise<TenantSettingsRecord> {
    const current = await this.store.getTenantSettings(context);
    const redaction: RedactionSettingsRecord = { ...current.redaction, ...(body.redaction ?? {}) };
    const retention: RetentionSettingsRecord = { ...current.retention, ...(body.retention ?? {}) };
    if (!Array.isArray(redaction.customPatterns) || redaction.customPatterns.length > 64) {
      invalidSettings("redaction.customPatterns must be an array of at most 64 patterns");
    }
    for (const pattern of redaction.customPatterns) {
      if (typeof pattern !== "string") invalidSettings("redaction.customPatterns entries must be strings");
      try {
        new RegExp(pattern);
      } catch {
        invalidSettings(`redaction.customPatterns entry is not a valid regular expression: ${pattern}`);
      }
    }
    if (retention.policy !== "indefinite" && retention.policy !== "days") {
      invalidSettings("retention.policy must be one of: indefinite, days");
    }
    if (retention.policy === "days") {
      if (!Number.isInteger(retention.days) || (retention.days ?? 0) < 1) {
        invalidSettings("retention.days must be an integer >= 1 when policy is days");
      }
    } else {
      delete retention.days;
    }
    const settings: TenantSettingsRecord = { redaction, retention, updatedAt: new Date().toISOString() };
    await this.store.saveTenantSettings(context, settings);
    return settings;
  }
}

export const RETENTION_SYSTEM_USER = "00000000-0000-7000-8000-000000000001";

/**
 * Applies every account's deletion policy, one account at a time.
 *
 * One tenant's failure used to end the whole sweep: the loop had no guard, so a
 * deadlock against a concurrent parse, or a single unreadable settings row,
 * threw out of here and the worker logged "[retention] sweep failed" and tried
 * again in an hour — from the top of the same list, in the same order, hitting
 * the same tenant. Every account behind it kept data it had asked to have
 * deleted, for as long as the first one stayed broken, and nothing said which
 * accounts those were. A deletion policy that silently stops deleting is the
 * worst way for this to fail, so a tenant that cannot be swept is counted and
 * named and the rest of the list is still swept.
 */
export async function runRetentionSweep(
  store: SettingsStore & RetentionStore,
  now = new Date(),
): Promise<{ sweptTenants: number; deletedSessions: number; deletedArtifacts: number; failedTenants: { tenantId: string; error: string }[] }> {
  let sweptTenants = 0;
  let deletedSessions = 0;
  let deletedArtifacts = 0;
  const failedTenants: { tenantId: string; error: string }[] = [];
  for (const tenantId of await store.listTenantIds()) {
    const context: TenantContext = { tenantId, userId: RETENTION_SYSTEM_USER, scopes: ["*"], authType: "machine" };
    try {
      const settings = await store.getTenantSettings(context);
      if (settings.retention.policy !== "days" || !settings.retention.days) continue;
      const cutoff = new Date(now.getTime() - settings.retention.days * 24 * 3600 * 1000).toISOString();
      const result = await store.applyRetention(context, cutoff, settings.retention.exemptCollected);
      sweptTenants += 1;
      deletedSessions += result.deletedSessions;
      deletedArtifacts += result.deletedArtifacts;
    } catch (error) {
      failedTenants.push({ tenantId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { sweptTenants, deletedSessions, deletedArtifacts, failedTenants };
}

@Controller("settings")
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get()
  get(@Tenant() context: TenantContext) {
    return this.settings.get(context);
  }

  @Put()
  update(
    @Tenant() context: TenantContext,
    @Body() body: UpdateSettingsDto,
  ) {
    return this.settings.update(context, body);
  }
}
