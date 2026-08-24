import type { ArchiveStore, ArchivedSession, TenantContext } from "./archive-store.js";

export const DEMO_CONTEXT: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-000000000002",
  userId: "0191cafe-0000-7000-8000-000000000002",
  scopes: ["*"],
  authType: "dev",
};

export const DEMO_SESSION: ArchivedSession = {
  id: "0191cafe-0000-7000-8000-00000000d001",
  source: {
    vendor: "openai",
    tool: "codex",
    version: "0.1.0-demo",
    machineId: "0191cafe-0000-7000-8000-00000000d002",
    nativeSessionId: "memoar-demo-archive-parser",
  },
  workspace: {
    path: "/workspace/memoar",
    gitRemote: "https://example.invalid/memoarhq/memoar.git",
    branch: "main",
  },
  createdAt: "2026-08-17T09:00:00.000Z",
  updatedAt: "2026-08-17T09:07:00.000Z",
  title: "Preserve unknown archive parser formats",
  summary: "A parser decision that keeps raw artifacts when a vendor format changes.",
  models: ["gpt-5"],
  tokenTotals: { input: 622, output: 318, cacheRead: 120 },
  provenance: [{
    kind: "native",
    sourceId: "memoar-demo-archive-parser",
    capturedAt: "2026-08-17T09:07:00.000Z",
    parserVersion: "0.1.0",
    details: { demo: true },
  }],
  visibility: { scope: "private", ownerId: DEMO_CONTEXT.userId },
  turns: [
    {
      id: "0191cafe-0000-7000-8000-00000000d003",
      ordinal: 0,
      parentId: null,
      role: "user",
      createdAt: "2026-08-17T09:00:00.000Z",
      blocks: [{
        id: "0191cafe-0000-7000-8000-00000000d004",
        kind: "text",
        text: "Decide how the archive ingest pipeline should handle an unknown parser format.",
      }],
    },
    {
      id: "0191cafe-0000-7000-8000-00000000d005",
      ordinal: 1,
      parentId: "0191cafe-0000-7000-8000-00000000d003",
      role: "assistant",
      createdAt: "2026-08-17T09:07:00.000Z",
      model: "gpt-5",
      tokens: { input: 622, output: 318 },
      blocks: [{
        id: "0191cafe-0000-7000-8000-00000000d006",
        kind: "text",
        text: "Decision: store the content-addressed raw artifact first. If format detection or parsing fails, mark it unknown_format with a diagnostic. Never discard the bytes. Reprocessing stays idempotent because the tenant and SHA-256 digest form the natural key.",
      }],
    },
  ],
  ext: { demoAdapter: true },
  redactionStatus: "clear",
};

export async function seedDevelopmentArchive(store: ArchiveStore): Promise<void> {
  const existing = await store.getSession(DEMO_CONTEXT, DEMO_SESSION.id);
  if (!existing) await store.saveSession(DEMO_CONTEXT, DEMO_SESSION);
}
