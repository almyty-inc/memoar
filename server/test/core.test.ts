import { describe, expect, it } from "vitest";
import type { ArchivedSession, TenantContext } from "../src/archive-store.js";
import { SharingService } from "../src/curation.js";
import { DEMO_CONTEXT, DEMO_SESSION } from "../src/demo-data.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { DistillationService, type DistillationProvider } from "../src/distillation.js";
import { DeterministicLexicalBackend, DisabledSemanticSearchProvider, PackService, SearchService } from "../src/search.js";

function tenant(id: string): TenantContext {
  return { tenantId: id, userId: id, scopes: ["*"], authType: "dev" };
}

function sessionFor(context: TenantContext, id = DEMO_SESSION.id): ArchivedSession {
  return {
    ...structuredClone(DEMO_SESSION),
    id,
    visibility: { scope: "private", ownerId: context.userId },
  };
}

describe("tenant isolation", () => {
  it("never returns another tenant's rows or mutable annotations", async () => {
    const store = new DevArchiveStore();
    const alpha = tenant("0191cafe-0000-7000-8000-00000000a001");
    const beta = tenant("0191cafe-0000-7000-8000-00000000b001");
    const session = sessionFor(alpha);
    await store.saveSession(alpha, session);

    expect(await store.getSession(beta, session.id)).toBeNull();
    // The cheap existence check must answer the same question as the read it
    // replaced. A query that skips the tenant filter turns "does this exist"
    // into an oracle for another tenant's session ids.
    expect(await store.sessionExists(alpha, session.id)).toBe(true);
    expect(await store.sessionExists(beta, session.id)).toBe(false);
    expect((await store.listSessions(beta, { limit: 10 })).items).toEqual([]);
    await expect(store.createAnnotation(beta, { sessionId: session.id, kind: "note", value: { markdown: "leak" } }))
      .rejects.toThrow("session_not_found");

    const annotation = await store.createAnnotation(alpha, { sessionId: session.id, kind: "note", value: { markdown: "tenant alpha" } });
    expect((await store.listAnnotations(beta)).find((item) => item.id === annotation.id)).toBeUndefined();
  });
});

describe("pack budgets", () => {
  it("is deterministic and enforces every requested limit", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(DEMO_CONTEXT, DEMO_SESSION);
    const search = new SearchService(new DeterministicLexicalBackend(store), new DisabledSemanticSearchProvider());
    const packs = new PackService(search, () => new Date("2026-08-18T00:00:00.000Z"));
    const request = {
      query: "archive parser decision",
      maxTokens: 64,
      maxEvidence: 1,
      maxSessions: 1,
      maxExcerptChars: 80,
      freshnessPolicy: "mixed" as const,
      staleAfterDays: 30,
    };

    const first = await packs.build(DEMO_CONTEXT, request);
    const second = await packs.build(DEMO_CONTEXT, request);
    expect(first).toEqual(second);
    expect(first.tokenEstimate).toBeLessThanOrEqual(64);
    expect(first.evidence).toHaveLength(1);
    const evidence = first.evidence as { excerpt: string; sessionId: string }[];
    expect(evidence[0]!.excerpt.length).toBeLessThanOrEqual(80);
    expect(new Set(evidence.map((item) => item.sessionId)).size).toBeLessThanOrEqual(1);
    expect(first.markdown).toContain(DEMO_SESSION.id);
  });
});

describe("redaction review gate", () => {
  it("requires a completed review and invalidates it when captured content changes", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(DEMO_CONTEXT, DEMO_SESSION);
    const sharing = new SharingService(store);

    await expect(sharing.createLink(DEMO_CONTEXT, {
      sessionId: DEMO_SESSION.id,
      permission: "viewer",
      redactionReviewId: "0191cafe-0000-7000-8000-00000000ffff",
    })).rejects.toMatchObject({ status: 409 });

    const review = await sharing.completeReview(DEMO_CONTEXT, DEMO_SESSION.id);
    const grant = await sharing.createLink(DEMO_CONTEXT, {
      sessionId: DEMO_SESSION.id,
      permission: "importer",
      redactionReviewId: review.id,
    });
    expect(grant.status).toBe("active");

    const changed = structuredClone(DEMO_SESSION);
    changed.turns[1]!.blocks[0]!.text = "Captured content changed after review.";
    await store.saveSession(DEMO_CONTEXT, changed);
    await expect(sharing.createLink(DEMO_CONTEXT, {
      sessionId: changed.id,
      permission: "viewer",
      redactionReviewId: review.id,
    })).rejects.toMatchObject({ status: 409 });
  });
});

describe("distillation cost cap", () => {
  it("does not call a provider when the estimate exceeds remaining opt-in budget", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(DEMO_CONTEXT, DEMO_SESSION);
    await store.saveDistillationSettings(DEMO_CONTEXT, {
      enabled: true,
      monthlyBudgetCents: 5,
      monthlySpentCents: 4,
      // Relative to now, not a fixed date: the spend resets once the window is
      // 30 days old, so a hardcoded date turns this into a test that passes
      // until exactly 30 days after it was written and then stops.
      budgetWindowStartedAt: new Date().toISOString(),
    });
    let called = false;
    const provider: DistillationProvider = {
      estimateCostCents: () => 2,
      distill: () => {
        called = true;
        return Promise.resolve({ notes: [], inputTokens: 0, outputTokens: 0, costCents: 2 });
      },
    };
    const service = new DistillationService(store, provider);
    await expect(service.run(DEMO_CONTEXT, DEMO_SESSION.id)).rejects.toMatchObject({ response: { code: "distillation_cost_cap_exceeded" } });
    expect(called).toBe(false);
  });
});
