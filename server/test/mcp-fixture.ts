/**
 * One MCP tool registry over one store, and an archive for it to read.
 *
 * The tools are Nest providers, but nothing here needs a running application:
 * every group takes the services it uses in its constructor, so a test can
 * build the whole surface over a `DevArchiveStore` and call it directly. The
 * transport test still stands up Nest; these are for the tools themselves.
 *
 * `seedArchive` deliberately gives a second account data of the same shape —
 * the same workspace path, the same machine id, the same collection name — so a
 * tool that ever reads outside its tenant fails as a collision in a test rather
 * than as a disclosure in production.
 */

import { AnnotationService } from "../src/annotations/annotations.service.js";
import type { ArchiveStore, ArchivedSession, MachineRecord, TenantContext } from "../src/archive-store.js";
import { CollectionService } from "../src/collections/collections.service.js";
import { DisabledDistillationProvider, DistillationService } from "../src/distillation.js";
import { MachinesService } from "../src/machines.js";
import { McpAnnotationTools } from "../src/mcp/annotation-tools.js";
import { McpArchiveTools } from "../src/mcp/archive-tools.js";
import { McpCollectionTools } from "../src/mcp/collection-tools.js";
import { McpCoreTools } from "../src/mcp/core-tools.js";
import { McpMemoryTools } from "../src/mcp/memory-tools.js";
import { McpProjectMemoryTools } from "../src/mcp/project-memory-tools.js";
import { McpToolRegistry } from "../src/mcp/registry.js";
import { McpSharingTools } from "../src/mcp/sharing-tools.js";
import { MemoryService } from "../src/memory/memory.service.js";
import { DeterministicLexicalBackend, DisabledSemanticSearchProvider, PackService, SearchService } from "../src/search.js";
import { SessionsService } from "../src/sessions.js";
import { SharingService } from "../src/sharing/sharing.service.js";
import { TeamsService } from "../src/teams.js";
import { TeamSearchService } from "../src/search/team-search.js";
import { TeamWorkspaceService } from "../src/team-workspace.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";

export function buildRegistry(store: ArchiveStore, now = () => new Date("2026-08-19T00:00:00.000Z")): McpToolRegistry {
  const search = new SearchService(new DeterministicLexicalBackend(store), new DisabledSemanticSearchProvider());
  const sessions = new SessionsService(store);
  const collections = new CollectionService(store);
  const annotations = new AnnotationService(store);
  const teams = new TeamsService(store);
  const workspace = new TeamWorkspaceService(
    store,
    teams,
    new TeamSearchService(new DeterministicLexicalBackend(store), new DisabledSemanticSearchProvider()),
  );
  return new McpToolRegistry(
    new McpCoreTools(search, new PackService(search, now), sessions, collections, annotations, store, workspace),
    new McpArchiveTools(sessions, new MachinesService(store)),
    new McpAnnotationTools(annotations),
    new McpCollectionTools(collections),
    new McpSharingTools(new SharingService(store)),
    new McpProjectMemoryTools(new DistillationService(store, new DisabledDistillationProvider())),
    new McpMemoryTools(new MemoryService(store)),
  );
}

export const OTHER_CONTEXT: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000a1",
  userId: "0191cafe-0000-7000-8000-0000000000a2",
  scopes: ["*"],
  authType: "dev",
};

export const MACHINE = TEST_SESSION.source.machineId;
export const OTHER_MACHINE = "0191cafe-0000-7000-8000-0000000000b2";
export const THIRD_MACHINE = "0191cafe-0000-7000-8000-0000000000b3";
export const SECOND_SESSION = "0191cafe-0000-7000-8000-0000000000c1";
export const THEIR_SESSION = "0191cafe-0000-7000-8000-0000000000c2";
export const LONG_SESSION = "0191cafe-0000-7000-8000-0000000000c3";
export const MY_COLLECTION = "0191cafe-0000-7000-8000-0000000000d1";
export const THEIR_COLLECTION = "0191cafe-0000-7000-8000-0000000000d2";

export function items(result: Record<string, unknown>): Record<string, unknown>[] {
  return result.items as Record<string, unknown>[];
}

function session(overrides: Partial<ArchivedSession> & { id: string }, owner: TenantContext): ArchivedSession {
  return {
    ...structuredClone(TEST_SESSION),
    visibility: { scope: "private", ownerId: owner.userId },
    ...overrides,
  };
}

function machine(id: string, tenantId: string, name: string): MachineRecord {
  return { id, tenantId, name, platform: "macos", agentVersion: "0.1.0", sourceSettings: { codex: { enabled: true } }, lastSeenAt: null };
}

/** A note of the shape `DistillationService.exportProjectMemory` looks for. */
function distilled(store: ArchiveStore, context: TenantContext, sessionId: string, markdown: string): Promise<unknown> {
  return store.createAnnotation(context, {
    sessionId,
    kind: "note",
    value: { markdown, provenance: "distillation", topic: "decisions", source: { sessionId, turnStart: 0, turnEnd: 1 } },
  });
}

export async function seedArchive(store: ArchiveStore): Promise<void> {
  await store.saveSession(TEST_CONTEXT, TEST_SESSION);
  await store.saveSession(TEST_CONTEXT, session({
    id: SECOND_SESSION,
    title: "Second session on the other laptop",
    updatedAt: "2026-08-18T09:00:00.000Z",
    models: ["claude-opus-5"],
    source: { ...structuredClone(TEST_SESSION.source), tool: "claude-code", machineId: OTHER_MACHINE },
    workspace: { path: "/workspace/other", branch: "main" },
  }, TEST_CONTEXT));
  await store.saveSession(TEST_CONTEXT, session({
    id: LONG_SESSION,
    title: "A workspace with a lot of distilled memory",
    updatedAt: "2026-08-16T09:00:00.000Z",
    models: ["gemini-3"],
    source: { ...structuredClone(TEST_SESSION.source), tool: "goose", machineId: THIRD_MACHINE },
    workspace: { path: "/workspace/long", branch: "main" },
  }, TEST_CONTEXT));
  await distilled(store, TEST_CONTEXT, LONG_SESSION, "z".repeat(5_000));
  await store.saveMachine(TEST_CONTEXT, machine(MACHINE, TEST_CONTEXT.tenantId, "workshop"));
  await store.saveMachine(TEST_CONTEXT, machine(OTHER_MACHINE, TEST_CONTEXT.tenantId, "laptop"));
  await store.saveCollection(TEST_CONTEXT, {
    id: MY_COLLECTION, tenantId: TEST_CONTEXT.tenantId, name: "parser decisions",
    sessionIds: [TEST_SESSION.id], updatedAt: "2026-08-18T00:00:00.000Z",
  });
  await store.createAnnotation(TEST_CONTEXT, { sessionId: TEST_SESSION.id, kind: "tag", value: { tag: "ingest" } });
  await distilled(store, TEST_CONTEXT, TEST_SESSION.id, "Keep the raw artifact before parsing.");
  await store.saveShareGrant(TEST_CONTEXT, {
    id: "0191cafe-0000-7000-8000-0000000000e1", tenantId: TEST_CONTEXT.tenantId, sessionId: TEST_SESSION.id,
    permission: "viewer", tokenHash: "f".repeat(64), status: "active",
    createdAt: "2026-08-18T00:00:00.000Z", expiresAt: null,
  });
  await store.saveTransfer(TEST_CONTEXT, {
    id: "0191cafe-0000-7000-8000-0000000000f1", tenantId: TEST_CONTEXT.tenantId, sessionId: TEST_SESSION.id,
    senderEmail: "mine@example.invalid", recipientEmail: "friend@example.invalid",
    status: "pending", createdAt: "2026-08-18T00:00:00.000Z",
  });

  // The same shapes, in another account.
  await store.saveSession(OTHER_CONTEXT, session({ id: THEIR_SESSION, title: "Not yours to read" }, OTHER_CONTEXT));
  await store.saveMachine(OTHER_CONTEXT, machine(OTHER_MACHINE, OTHER_CONTEXT.tenantId, "workshop"));
  await store.saveCollection(OTHER_CONTEXT, {
    id: THEIR_COLLECTION, tenantId: OTHER_CONTEXT.tenantId, name: "parser decisions",
    sessionIds: [THEIR_SESSION], updatedAt: "2026-08-18T00:00:00.000Z",
  });
  await store.createAnnotation(OTHER_CONTEXT, { sessionId: THEIR_SESSION, kind: "tag", value: { tag: "secret" } });
  await distilled(store, OTHER_CONTEXT, THEIR_SESSION, "Their private decision.");
  await store.saveShareGrant(OTHER_CONTEXT, {
    id: "0191cafe-0000-7000-8000-0000000000e2", tenantId: OTHER_CONTEXT.tenantId, sessionId: THEIR_SESSION,
    permission: "importer", tokenHash: "e".repeat(64), status: "active",
    createdAt: "2026-08-18T00:00:00.000Z", expiresAt: null,
  });
  await store.saveTransfer(OTHER_CONTEXT, {
    id: "0191cafe-0000-7000-8000-0000000000f2", tenantId: OTHER_CONTEXT.tenantId, sessionId: THEIR_SESSION,
    senderEmail: "theirs@example.invalid", recipientEmail: "someone@example.invalid",
    status: "pending", createdAt: "2026-08-18T00:00:00.000Z",
  });
}
