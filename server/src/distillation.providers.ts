// The models a distillation can be asked of, and the one that refuses.
// Split out of distillation.ts, which was over the file-size rule.

import Anthropic from "@anthropic-ai/sdk";
import type { ArchivedSession } from "./archive-store.js";
import type { AnthropicClientPort, DistillationProvider, DistillationResult, DistilledNoteDraft } from "./distillation.types.js";

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
