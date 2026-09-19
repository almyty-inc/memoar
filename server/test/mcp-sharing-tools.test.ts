/**
 * Sharing reads, project memory, and the arguments every tool refuses.
 *
 * The sharing tools are read-only by design; one test asserts that the tools
 * that would widen or narrow who can see a session are simply not present, so
 * adding one later is a deliberate act with a test to answer to.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import type { McpToolRegistry } from "../src/mcp/registry.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { buildRegistry, items, MY_COLLECTION, OTHER_CONTEXT, seedArchive, THEIR_SESSION } from "./mcp-fixture.js";

const store = new DevArchiveStore();
let tools: McpToolRegistry;

function call(context: TenantContext, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return tools.call(context, name, args);
}

beforeAll(async () => {
  tools = buildRegistry(store);
  await seedArchive(store);
});

describe("sharing tools are read-only", () => {
  it("lists this account's links without ever returning a usable token", async () => {
    const page = await call(TEST_CONTEXT, "list_share_links");
    expect(items(page)).toHaveLength(1);
    expect(items(page)[0]).toMatchObject({ sessionId: TEST_SESSION.id, permission: "viewer", status: "active" });
    expect(items(page)[0], "the secret exists only in the response to POST /sharing/links").not.toHaveProperty("token");
    expect(items(page)[0]).not.toHaveProperty("tokenHash");
  });

  it("lists transfers and keeps the two accounts' apart", async () => {
    expect(items(await call(TEST_CONTEXT, "list_transfers")).map((item) => item.recipientEmail)).toEqual(["friend@example.invalid"]);
    expect(items(await call(OTHER_CONTEXT, "list_transfers")).map((item) => item.recipientEmail)).toEqual(["someone@example.invalid"]);
    expect(items(await call(OTHER_CONTEXT, "list_share_links")).map((item) => item.sessionId)).toEqual([THEIR_SESSION]);
  });

  it("offers no tool that widens or narrows who can see a session", () => {
    const names = tools.names;
    for (const withheld of [
      "create_share_link", "revoke_share_link", "update_session_visibility",
      "complete_redaction_review", "request_transfer", "accept_transfer", "decline_transfer", "import_share",
      "delete_session", "delete_memory_document", "create_api_key",
    ]) {
      expect(names, `${withheld} is withheld on purpose; docs/mcp.md says why`).not.toContain(withheld);
    }
  });
});

describe("export_project_memory", () => {
  it("renders the distilled notes for one workspace, cited", async () => {
    const result = await call(TEST_CONTEXT, "export_project_memory", { workspace: "/workspace/memoar", format: "claude" });
    expect(result.noteCount).toBe(1);
    expect(result.markdown).toContain("# Project memory for CLAUDE.md");
    expect(result.markdown).toContain("Keep the raw artifact before parsing.");
    expect(result.markdown).toContain(`Source: ${TEST_SESSION.id} turns 0-1`);
    expect(result.truncated).toBe(false);
  });

  it("bounds the markdown it returns and says when it cut it", async () => {
    const result = await call(TEST_CONTEXT, "export_project_memory", { workspace: "/workspace/long", maxChars: 200 });
    expect((result.markdown as string)).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it("does not render the other account's notes for the same workspace path", async () => {
    const mine = await call(TEST_CONTEXT, "export_project_memory", { workspace: "/workspace/memoar" });
    const theirs = await call(OTHER_CONTEXT, "export_project_memory", { workspace: "/workspace/memoar" });
    expect(mine.markdown).not.toContain("Their private decision.");
    expect(theirs.markdown).toContain("Their private decision.");
    expect(theirs.markdown).not.toContain("Keep the raw artifact before parsing.");
  });
});

describe("arguments the tools refuse rather than guess at", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["list_sessions", { limit: 0 }],
    ["list_sessions", { limit: 101 }],
    ["list_sessions", { limit: "10" }],
    ["list_sessions", { machineId: "not-a-uuid" }],
    ["list_sessions", { from: "last tuesday" }],
    ["list_sessions", { unknownField: true }],
    ["list_machines", { limit: 201 }],
    ["list_machines", { extra: 1 }],
    ["list_annotations", { sessionId: "not-a-uuid" }],
    ["list_annotations", { maxValueChars: 199 }],
    ["list_annotations", { offset: -1 }],
    ["add_annotation", {}],
    ["add_annotation", { sessionId: TEST_SESSION.id, kind: "note" }],
    ["add_annotation", { sessionId: TEST_SESSION.id, kind: "note", value: "a string" }],
    ["add_annotation", { sessionId: TEST_SESSION.id, kind: "note", value: {}, extra: 1 }],
    ["create_collection", {}],
    ["create_collection", { name: "" }],
    ["create_collection", { name: "x", teamId: "not-a-uuid" }],
    ["create_collection", { name: "x", surprise: true }],
    ["list_collection_sessions", {}],
    ["list_collection_sessions", { collectionId: MY_COLLECTION, limit: 0 }],
    ["add_session_to_collection", { collectionId: MY_COLLECTION }],
    ["remove_session_from_collection", { collectionId: MY_COLLECTION, sessionId: "nope" }],
    ["list_share_links", { limit: 0 }],
    ["list_transfers", { token: "give it to me" }],
    ["export_project_memory", {}],
    ["export_project_memory", { workspace: "/w", format: "gemini" }],
    ["export_project_memory", { workspace: "/w", maxChars: 199 }],
    // The tools that were here before parity work read their arguments field by
    // field and coerced silently; they go through the same DTOs now.
    ["search_sessions", { query: "x", limit: "5" }],
    ["search_sessions", { query: "x", mode: "psychic" }],
    ["search_sessions", {}],
    ["get_excerpt", { sessionId: TEST_SESSION.id, turnStart: 0 }],
    ["get_session", { sessionId: TEST_SESSION.id, chunkSize: 500 }],
    ["get_memory", { topic: "x", maxTokens: 9_000 }],
    ["save_note", { sessionId: TEST_SESSION.id }],
    // pack used to be cast straight to PackRequest: an absent maxTokens became
    // NaN inside the budget arithmetic instead of a refusal here.
    ["pack", { query: "x" }],
    ["pack", { query: "x", maxTokens: 500, maxEvidence: 2, maxSessions: 1, maxExcerptChars: 100, freshnessPolicy: "whenever" }],
  ];

  it.each(cases)("%s refuses %j", async (name, args) => {
    await expect(call(TEST_CONTEXT, name, args)).rejects.toThrow(/invalid_arguments/u);
  });

  it("refuses a tool it does not have", async () => {
    await expect(call(TEST_CONTEXT, "delete_everything", {})).rejects.toThrow(/unknown_tool:delete_everything/u);
  });
});
