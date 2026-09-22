/**
 * One tenant and one session for tests to build on.
 *
 * This lived in `src/` and was seeded into the running archive by default,
 * which meant anyone starting the server saw a session they had never had. It
 * is a test fixture, so it lives with the tests, and the only thing that puts
 * it in an archive is a test that asked for it.
 */

import type { ArchiveStore, ArchivedSession, MachineStore, TenantContext } from "../../src/archive-store.js";

export const TEST_CONTEXT: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-000000000002",
  userId: "0191cafe-0000-7000-8000-000000000002",
  scopes: ["*"],
  authType: "dev",
};

export const TEST_SESSION: ArchivedSession = {
  id: "0191cafe-0000-7000-8000-00000000d001",
  source: {
    vendor: "openai",
    tool: "codex",
    version: "0.1.0-test",
    machineId: "0191cafe-0000-7000-8000-00000000d002",
    nativeSessionId: "memoar-test-archive-parser",
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
    sourceId: "memoar-test-archive-parser",
    capturedAt: "2026-08-17T09:07:00.000Z",
    parserVersion: "0.1.0",
    details: { fixture: true },
  }],
  visibility: { scope: "private", ownerId: TEST_CONTEXT.userId },
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
  ext: { fixture: true },
  redactionStatus: "clear",
};

export async function seedTestSession(store: ArchiveStore): Promise<void> {
  const existing = await store.getSession(TEST_CONTEXT, TEST_SESSION.id);
  if (!existing) await store.saveSession(TEST_CONTEXT, TEST_SESSION);
}

/**
 * A registered machine for the tests that file something under one.
 *
 * Capturing a memory file and queuing a materialize command both resolve the
 * machine id they are handed, so a test that invents one is now testing the
 * refusal. The fixture is a real row rather than a flag on the check: the
 * alternative is a bypass that production could also take.
 */
export async function seedMachine(
  store: MachineStore,
  context: TenantContext,
  id: string,
  name = "fixture-machine",
): Promise<void> {
  await store.saveMachine(context, {
    id,
    tenantId: context.tenantId,
    name,
    platform: "darwin",
    agentVersion: null,
    sourceSettings: {},
    lastSeenAt: null,
  });
}
