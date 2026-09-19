// What a distillation is, and what a provider must be able to do.
// Split out of distillation.ts, which was over the file-size rule.

import type { ArchivedSession } from "./archive-store.js";

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
