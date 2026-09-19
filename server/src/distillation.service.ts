// Turning a session into a durable note, within a budget.
// Split out of distillation.ts, which was over the file-size rule.

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AnnotationStore, DistillationSettings, JobRecord, JobStore, SessionStore, SettingsStore, TenantContext } from "./archive-store.js";
import { credentialHint, credentialsAvailable, openCredential, sealCredential } from "./credentials.js";
import { uuidV7 } from "./ids.js";
import { UpdateDistillationSettingsDto } from "./settings.dto.js";
import { ARCHIVE_STORE, DISTILLATION_PROVIDER } from "./tokens.js";
import type { DistillationProvider, DistillationResult } from "./distillation.types.js";
import { AnthropicDistillationProvider, AnthropicMessagesClient, DisabledDistillationProvider } from "./distillation.providers.js";

/** The window the store enforces a budget over, in milliseconds. */
export const BUDGET_WINDOW_MS = 30 * 24 * 3600 * 1000;

/**
 * What this account has spent against the budget it is under right now.
 *
 * The reset lives in `reserveDistillationBudget`, which is the only thing that
 * ever ran it: the stored counter keeps last window's total until the next
 * distillation is attempted. The settings endpoint read that stale counter
 * straight out of the row, so an account that spent its budget in August and
 * came back in October was shown `remainingCents: 0` and told its budget was
 * gone, while a distillation would have been reserved and run. The number a
 * person is shown has to be the number that is enforced.
 */
export function spentInCurrentWindow(settings: DistillationSettings, now = Date.now()): number {
  const startedAt = new Date(settings.budgetWindowStartedAt).getTime();
  if (!Number.isFinite(startedAt)) return settings.monthlySpentCents;
  return startedAt < now - BUDGET_WINDOW_MS ? 0 : settings.monthlySpentCents;
}

@Injectable()
export class DistillationService {
  constructor(
    @Inject(ARCHIVE_STORE) private readonly store: SessionStore & AnnotationStore & SettingsStore & JobStore,
    @Inject(DISTILLATION_PROVIDER) private readonly provider: DistillationProvider,
  ) {}

  /**
   * The settings as they leave the process.
   *
   * The sealed credential is not in here and must never be: this shape is the
   * PUT response as well as the GET body, and it is what a client logs. Only
   * whether a key is set, and its last four characters — enough to recognise
   * which key it is, not enough to use it.
   */
  private toWire(settings: DistillationSettings): Record<string, unknown> {
    const key = settings.sealedApiKey ? openCredential(settings.sealedApiKey) : null;
    const spent = spentInCurrentWindow(settings);
    return {
      enabled: settings.enabled,
      provider: settings.provider,
      model: settings.model,
      keySet: settings.sealedApiKey !== null,
      keyHint: key ? credentialHint(key) : null,
      monthlyBudgetCents: settings.monthlyBudgetCents,
      monthlySpentCents: spent,
      remainingCents: Math.max(0, settings.monthlyBudgetCents - spent),
      budgetWindowStartedAt: settings.budgetWindowStartedAt,
    };
  }

  /**
   * The provider this tenant distills with.
   *
   * Resolved per request from the account's own settings rather than injected
   * once for the whole process. The injected provider is the operator's shared
   * key, which is only reachable when the operator has explicitly said it may
   * be spent on everybody's behalf.
   */
  private providerFor(settings: DistillationSettings): DistillationProvider {
    if (settings.provider === "anthropic" && settings.sealedApiKey) {
      const key = openCredential(settings.sealedApiKey);
      // A key that will not open is a key that cannot be spent: this happens
      // when MEMOAR_CREDENTIAL_KEY has been rotated, and the account has to set
      // theirs again. Better to say distillation is unavailable than to fall
      // back to somebody else's credential.
      if (key) return new AnthropicDistillationProvider(new AnthropicMessagesClient(key), settings.model ?? undefined);
      return new DisabledDistillationProvider();
    }
    if (process.env.MEMOAR_ALLOW_SHARED_DISTILLATION_KEY === "true") return this.provider;
    return new DisabledDistillationProvider();
  }

  /** Seals a credential, refusing rather than storing one weakly. */
  private seal(apiKey: string): string {
    if (!credentialsAvailable()) {
      throw new ConflictException({
        type: "https://memoar.dev/problems/credentials-unavailable",
        title: "This deployment cannot store provider credentials",
        status: 409,
        code: "credentials_unavailable",
        detail: "MEMOAR_CREDENTIAL_KEY is not configured, so a provider key cannot be encrypted at rest",
      });
    }
    return sealCredential(apiKey);
  }

  async getSettings(context: TenantContext): Promise<Record<string, unknown>> {
    return this.toWire(await this.store.getDistillationSettings(context));
  }

  async updateSettings(context: TenantContext, body: UpdateDistillationSettingsDto): Promise<Record<string, unknown>> {
    if (body.monthlyBudgetCents !== undefined && (!Number.isInteger(body.monthlyBudgetCents) || body.monthlyBudgetCents < 0)) {
      throw new BadRequestException({
        type: "https://memoar.dev/problems/invalid-settings",
        title: "Invalid settings",
        status: 400,
        code: "invalid_settings",
        detail: "monthlyBudgetCents must be a non-negative integer",
      });
    }
    const current = await this.store.getDistillationSettings(context);
    const next: DistillationSettings = {
      ...current,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.provider !== undefined ? { provider: body.provider } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.monthlyBudgetCents !== undefined ? { monthlyBudgetCents: body.monthlyBudgetCents } : {}),
      // Three states, not two. Absent leaves the stored credential alone —
      // otherwise every update that did not resend the key would delete it —
      // null clears it, and a string replaces it.
      ...(body.apiKey === undefined ? {} : { sealedApiKey: body.apiKey === null ? null : this.seal(body.apiKey) }),
    };
    // A provider with no credential cannot distill, and saying so when it is
    // chosen is far better than a job that fails much later for no stated
    // reason.
    if (next.provider !== "none" && next.sealedApiKey === null) {
      throw new BadRequestException({
        type: "https://memoar.dev/problems/invalid-settings",
        title: "Invalid settings",
        status: 400,
        code: "invalid_settings",
        detail: `${next.provider} needs an apiKey: send one with the provider, or set provider to "none"`,
      });
    }
    await this.store.saveDistillationSettings(context, next);
    return this.toWire(next);
  }

  private jobWire(job: JobRecord): Record<string, unknown> {
    return {
      id: job.id,
      sessionId: job.payload.sessionId,
      status: job.status,
      createdAt: job.createdAt,
      ...(job.result ?? {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  async getJob(context: TenantContext, jobId: string): Promise<Record<string, unknown>> {
    const job = await this.store.getJob(context, jobId);
    if (!job || job.kind !== "distill") throw new NotFoundException("Distillation job not found");
    return this.jobWire(job);
  }

  async run(context: TenantContext, sessionId: string): Promise<Record<string, unknown>> {
    const [settings, session] = await Promise.all([
      this.store.getDistillationSettings(context),
      this.store.getSession(context, sessionId),
    ]);
    if (!session) throw new NotFoundException("Session not found");
    if (!settings.enabled) {
      throw new ConflictException({
        type: "https://memoar.dev/problems/distillation-not-opted-in",
        title: "Distillation is not opted in",
        status: 409,
        code: "distillation_not_opted_in",
      });
    }
    // This account's provider, with this account's credential.
    const provider = this.providerFor(settings);
    // Clamp so budget arithmetic stays inside int4 even for providers that
    // return an effectively-infinite estimate (e.g. the disabled provider).
    const estimate = Math.min(provider.estimateCostCents(session), 1_000_000_000);
    const reservation = await this.store.reserveDistillationBudget(context, estimate);
    if (!reservation.reserved) {
      throw new ConflictException({
        type: "https://memoar.dev/problems/distillation-cost-cap-exceeded",
        title: "Estimated cost exceeds the remaining monthly distillation budget",
        status: 409,
        code: "distillation_cost_cap_exceeded",
        estimatedCents: estimate,
        remainingCents: reservation.remainingCents,
      });
    }
    const createdAt = new Date().toISOString();
    const job: JobRecord = {
      id: uuidV7(), tenantId: context.tenantId, kind: "distill", status: "running",
      payload: { sessionId }, result: null, error: null, createdAt, updatedAt: createdAt,
    };
    await this.store.saveJob(context, job);
    let result: DistillationResult;
    try {
      result = await provider.distill(session, reservation.remainingCents);
    } catch (error) {
      await this.store.settleDistillationSpend(context, -estimate);
      const message = error instanceof Error ? error.message : "distillation_failed";
      const failed: JobRecord = { ...job, status: "failed", error: message, updatedAt: new Date().toISOString() };
      await this.store.saveJob(context, failed);
      return this.jobWire(failed);
    }
    await this.store.settleDistillationSpend(context, result.costCents - estimate);
    const annotationIds: string[] = [];
    for (const note of result.notes) {
      const annotation = await this.store.createAnnotation(context, {
        sessionId,
        kind: "note",
        value: {
          topic: note.topic,
          memoryKind: note.kind,
          markdown: note.markdown,
          source: { sessionId, turnStart: note.turnStart, turnEnd: note.turnEnd },
          provenance: "distillation",
        },
      });
      annotationIds.push(annotation.id);
    }
    const after = await this.store.getDistillationSettings(context);
    const ready: JobRecord = {
      ...job,
      status: "ready",
      result: {
        noteIds: annotationIds,
        costCents: result.costCents,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        remainingCents: Math.max(0, after.monthlyBudgetCents - after.monthlySpentCents),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveJob(context, ready);
    return this.jobWire(ready);
  }

  async exportProjectMemory(context: TenantContext, workspace: string, format: "claude" | "agents"): Promise<Record<string, unknown>> {
    const page = await this.store.listSessions(context, { workspace, limit: 100 });
    const notes = (await Promise.all(page.items.map((session) => this.store.listAnnotations(context, session.id))))
      .flat().filter((annotation) => annotation.kind === "note" && annotation.value.provenance === "distillation");
    const title = format === "claude" ? "# Project memory for CLAUDE.md" : "# Project memory for AGENTS.md";
    const markdown = [title, "", ...notes.map((note) => {
      const source = note.value.source && typeof note.value.source === "object" && !Array.isArray(note.value.source)
        ? note.value.source as Record<string, unknown> : undefined;
      const body = typeof note.value.markdown === "string" ? note.value.markdown : "";
      const sessionId = typeof source?.sessionId === "string" ? source.sessionId : note.sessionId;
      const turnStart = typeof source?.turnStart === "number" || typeof source?.turnStart === "string" ? source.turnStart : "?";
      const turnEnd = typeof source?.turnEnd === "number" || typeof source?.turnEnd === "string" ? source.turnEnd : "?";
      return `${body}\n\nSource: ${sessionId} turns ${turnStart}-${turnEnd}`;
    })].join("\n\n");
    return { workspace, format, markdown, noteCount: notes.length };
  }
}
