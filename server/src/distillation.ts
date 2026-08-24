import Anthropic from "@anthropic-ai/sdk";
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Post, Put, Query } from "@nestjs/common";
import type { AnnotationStore, ArchivedSession, DistillationSettings, JobRecord, JobStore, SessionStore, SettingsStore, TenantContext } from "./archive-store.js";
import { Tenant } from "./auth.js";
import { uuidV7 } from "./ids.js";
import { UpdateDistillationSettingsDto } from "./settings.dto.js";
import { ARCHIVE_STORE, DISTILLATION_PROVIDER } from "./tokens.js";

export interface DistilledNoteDraft {
  topic: string;
  kind: "decision" | "solution" | "environment" | "convention";
  markdown: string;
  turnStart: number;
  turnEnd: number;
}

export interface DistillationResult {
  notes: DistilledNoteDraft[];
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface DistillationProvider {
  estimateCostCents(session: ArchivedSession): number;
  distill(session: ArchivedSession, maximumCostCents: number): Promise<DistillationResult>;
}

export interface AnthropicClientPort {
  createMessage(input: { model: string; maxTokens: number; system: string; prompt: string }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  }>;
}

export class AnthropicMessagesClient implements AnthropicClientPort {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly inputCentsPerMillionTokens = 500,
    private readonly outputCentsPerMillionTokens = 2500,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async createMessage(input: { model: string; maxTokens: number; system: string; prompt: string }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  }> {
    const response = await this.client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: [{ role: "user", content: input.prompt }],
    });
    if (response.stop_reason === "refusal") throw new Error("distillation_model_refused");
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costCents = Math.max(1, Math.ceil(
      (inputTokens * this.inputCentsPerMillionTokens + outputTokens * this.outputCentsPerMillionTokens) / 1_000_000,
    ));
    return { text, inputTokens, outputTokens, costCents };
  }
}

export function distillationProviderFromEnv(env: Record<string, string | undefined> = process.env): DistillationProvider {
  const kind = env.MEMOAR_DISTILLATION_PROVIDER ?? "disabled";
  if (kind === "disabled") return new DisabledDistillationProvider();
  if (kind !== "anthropic") throw new Error(`Unknown MEMOAR_DISTILLATION_PROVIDER: ${kind}`);
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required when MEMOAR_DISTILLATION_PROVIDER=anthropic");
  const client = new AnthropicMessagesClient(
    apiKey,
    Number(env.MEMOAR_DISTILLATION_INPUT_CENTS_PER_MTOK ?? 500),
    Number(env.MEMOAR_DISTILLATION_OUTPUT_CENTS_PER_MTOK ?? 2500),
  );
  return new AnthropicDistillationProvider(client, env.MEMOAR_DISTILLATION_MODEL ?? "claude-opus-5");
}

export class AnthropicDistillationProvider implements DistillationProvider {
  constructor(private readonly client: AnthropicClientPort, private readonly model = "claude-opus-5") {}

  estimateCostCents(session: ArchivedSession): number {
    const characters = session.turns.reduce((sum, turn) => sum + turn.blocks.reduce((blockSum, block) => blockSum + (block.text?.length ?? 0), 0), 0);
    return Math.max(1, Math.ceil(characters / 12_000));
  }

  async distill(session: ArchivedSession, maximumCostCents: number): Promise<DistillationResult> {
    const response = await this.client.createMessage({
      model: this.model,
      maxTokens: Math.min(4_000, maximumCostCents * 400),
      system: "Extract durable project memory. Return a JSON array with topic, kind, markdown, turnStart, and turnEnd. Every note must cite its source turn span.",
      prompt: JSON.stringify({ id: session.id, workspace: session.workspace.path, turns: session.turns }),
    });
    const cleaned = response.text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
    const parsed = JSON.parse(cleaned) as unknown;
    const notes = Array.isArray(parsed) ? parsed.filter((value): value is DistilledNoteDraft => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      return typeof record.topic === "string" && typeof record.markdown === "string" && typeof record.turnStart === "number" && typeof record.turnEnd === "number"
        && (record.kind === "decision" || record.kind === "solution" || record.kind === "environment" || record.kind === "convention");
    }) : [];
    return { notes, inputTokens: response.inputTokens, outputTokens: response.outputTokens, costCents: response.costCents };
  }
}

export class DisabledDistillationProvider implements DistillationProvider {
  estimateCostCents(): number { return Number.MAX_SAFE_INTEGER; }
  distill(): Promise<DistillationResult> { return Promise.reject(new Error("distillation_provider_unconfigured")); }
}

@Injectable()
export class DistillationService {
  constructor(
    @Inject(ARCHIVE_STORE) private readonly store: SessionStore & AnnotationStore & SettingsStore & JobStore,
    @Inject(DISTILLATION_PROVIDER) private readonly provider: DistillationProvider,
  ) {}

  private toWire(settings: DistillationSettings): Record<string, unknown> {
    return {
      enabled: settings.enabled,
      monthlyBudgetCents: settings.monthlyBudgetCents,
      monthlySpentCents: settings.monthlySpentCents,
      remainingCents: Math.max(0, settings.monthlyBudgetCents - settings.monthlySpentCents),
      budgetWindowStartedAt: settings.budgetWindowStartedAt,
    };
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
      ...(body.monthlyBudgetCents !== undefined ? { monthlyBudgetCents: body.monthlyBudgetCents } : {}),
    };
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
    // Clamp so budget arithmetic stays inside int4 even for providers that
    // return an effectively-infinite estimate (e.g. the disabled provider).
    const estimate = Math.min(this.provider.estimateCostCents(session), 1_000_000_000);
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
      result = await this.provider.distill(session, reservation.remainingCents);
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

@Controller("distillation")
export class DistillationController {
  constructor(private readonly distillation: DistillationService) {}

  @Get("settings")
  getSettings(@Tenant() context: TenantContext) { return this.distillation.getSettings(context); }

  @Put("settings")
  updateSettings(@Tenant() context: TenantContext, @Body() body: UpdateDistillationSettingsDto) {
    return this.distillation.updateSettings(context, body);
  }

  @Get("jobs/:jobId")
  getJob(@Tenant() context: TenantContext, @Param("jobId") jobId: string) { return this.distillation.getJob(context, jobId); }

  @Post("sessions/:sessionId")
  @HttpCode(202)
  run(@Tenant() context: TenantContext, @Param("sessionId") sessionId: string) { return this.distillation.run(context, sessionId); }

  @Post("projects/export")
  export(
    @Tenant() context: TenantContext,
    @Query("workspace") workspace: string,
    @Query("format") format: "claude" | "agents" = "agents",
  ) { return this.distillation.exportProjectMemory(context, workspace, format); }
}
