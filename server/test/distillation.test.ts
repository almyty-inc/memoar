import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import {
  AnthropicDistillationProvider,
  DisabledDistillationProvider,
  DistillationService,
  distillationProviderFromEnv,
  type AnthropicClientPort,
} from "../src/distillation.js";

const context: TenantContext = TEST_CONTEXT;

function fakeClient(costCents: number, fail = false): AnthropicClientPort {
  return {
    createMessage() {
      if (fail) return Promise.reject(new Error("provider_down"));
      return Promise.resolve({
        text: `\`\`\`json\n${JSON.stringify([
          { topic: "raw artifacts", kind: "decision", markdown: "Always keep raw bytes before parsing.", turnStart: 0, turnEnd: 1 },
        ])}\n\`\`\``,
        inputTokens: 1000,
        outputTokens: 200,
        costCents,
      });
    },
  };
}

async function seededStore(budgetCents: number): Promise<DevArchiveStore> {
  const store = new DevArchiveStore();
  await store.saveSession(context, TEST_SESSION);
  await store.saveDistillationSettings(context, {
    enabled: true,
    monthlyBudgetCents: budgetCents,
    monthlySpentCents: 0,
    budgetWindowStartedAt: new Date().toISOString(),
  });
  return store;
}

describe("distillation", () => {
  it("selects providers from the environment", () => {
    expect(distillationProviderFromEnv({})).toBeInstanceOf(DisabledDistillationProvider);
    expect(distillationProviderFromEnv({ MEMOAR_DISTILLATION_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-not-a-real-key" }))
      .toBeInstanceOf(AnthropicDistillationProvider);
    expect(() => distillationProviderFromEnv({ MEMOAR_DISTILLATION_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => distillationProviderFromEnv({ MEMOAR_DISTILLATION_PROVIDER: "cursed" })).toThrow(/Unknown/);
  });

  it("distills a session into cited note annotations and charges actual cost", async () => {
    const store = await seededStore(1000);
    const provider = new AnthropicDistillationProvider(fakeClient(3));
    const service = new DistillationService(store, provider);
    const outcome = await service.run(context, TEST_SESSION.id);
    expect(outcome.status).toBe("ready");
    expect(outcome.noteIds).toHaveLength(1);
    expect(outcome.costCents).toBe(3);
    expect(await service.getJob(context, outcome.id as string)).toMatchObject({ status: "ready", sessionId: TEST_SESSION.id, costCents: 3 });
    const settings = await store.getDistillationSettings(context);
    expect(settings.monthlySpentCents).toBe(3);
    const annotations = await store.listAnnotations(context, TEST_SESSION.id);
    expect(annotations[0]!.value.provenance).toBe("distillation");
    expect(annotations[0]!.value.source).toMatchObject({ turnStart: 0, turnEnd: 1 });
  });

  it("rejects when the monthly budget cannot cover the estimate and spends nothing", async () => {
    const store = await seededStore(0);
    const service = new DistillationService(store, new AnthropicDistillationProvider(fakeClient(3)));
    await expect(service.run(context, TEST_SESSION.id)).rejects.toMatchObject({ response: { code: "distillation_cost_cap_exceeded" } });
    expect((await store.getDistillationSettings(context)).monthlySpentCents).toBe(0);
  });

  it("records a failed durable job and refunds the reservation when the provider fails", async () => {
    const store = await seededStore(1000);
    const service = new DistillationService(store, new AnthropicDistillationProvider(fakeClient(3, true)));
    const outcome = await service.run(context, TEST_SESSION.id);
    expect(outcome).toMatchObject({ status: "failed", error: "provider_down" });
    expect(await service.getJob(context, outcome.id as string)).toMatchObject({ status: "failed", error: "provider_down" });
    expect((await store.getDistillationSettings(context)).monthlySpentCents).toBe(0);
  });

  it("requires explicit opt-in", async () => {
    const store = await seededStore(1000);
    await store.saveDistillationSettings(context, {
      enabled: false, monthlyBudgetCents: 1000, monthlySpentCents: 0, budgetWindowStartedAt: new Date().toISOString(),
    });
    const service = new DistillationService(store, new AnthropicDistillationProvider(fakeClient(3)));
    await expect(service.run(context, TEST_SESSION.id)).rejects.toMatchObject({ response: { code: "distillation_not_opted_in" } });
  });

  it("round-trips settings through the wire shape with derived remainingCents", async () => {
    const store = await seededStore(1000);
    const service = new DistillationService(store, new AnthropicDistillationProvider(fakeClient(3)));
    expect(await service.getSettings(context)).toMatchObject({ enabled: true, monthlyBudgetCents: 1000, remainingCents: 1000 });
    const updated = await service.updateSettings(context, { monthlyBudgetCents: 500 });
    expect(updated).toMatchObject({ enabled: true, monthlyBudgetCents: 500, remainingCents: 500 });
    await expect(service.updateSettings(context, { monthlyBudgetCents: -1 })).rejects.toMatchObject({ response: { code: "invalid_settings" } });
    await expect(service.getJob(context, "0191cafe-0000-7000-8000-00000000dead")).rejects.toThrow("Distillation job not found");
  });
});
