/**
 * Finding and curating: the tools that closed the gap between what a person can
 * do in the web app's timeline, search and session views and what an agent
 * could do over MCP.
 *
 * The fixture seeds a second account holding data of the same shape, so a tool
 * that ever reads outside its tenant fails here as a collision.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import type { McpToolRegistry } from "../src/mcp/registry.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import {
  buildRegistry, items, LONG_SESSION, MACHINE, MY_COLLECTION, OTHER_CONTEXT, OTHER_MACHINE,
  SECOND_SESSION, seedArchive, THEIR_COLLECTION, THEIR_SESSION,
} from "./mcp-fixture.js";

const store = new DevArchiveStore();
let tools: McpToolRegistry;

function call(context: TenantContext, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return tools.call(context, name, args);
}

beforeAll(async () => {
  tools = buildRegistry(store);
  await seedArchive(store);
});

describe("list_sessions", () => {
  it("enumerates the archive without a search query and pages it", async () => {
    const page = await call(TEST_CONTEXT, "list_sessions");
    expect(items(page).map((item) => item.id)).toContain(TEST_SESSION.id);
    expect(page.total).toBe(3);

    const first = await call(TEST_CONTEXT, "list_sessions", { limit: 1 });
    expect(items(first)).toHaveLength(1);
    expect(first.total, "the total counts what matches, not what this page holds").toBe(3);
  });

  it("filters by agent, workspace, machine, model and date the way GET /sessions does", async () => {
    expect(items(await call(TEST_CONTEXT, "list_sessions", { agent: "claude-code" })).map((item) => item.id)).toEqual([SECOND_SESSION]);
    expect(items(await call(TEST_CONTEXT, "list_sessions", { workspace: "/workspace/other" })).map((item) => item.id)).toEqual([SECOND_SESSION]);
    expect(items(await call(TEST_CONTEXT, "list_sessions", { machineId: MACHINE })).map((item) => item.id)).toEqual([TEST_SESSION.id]);
    expect(items(await call(TEST_CONTEXT, "list_sessions", { model: "claude-opus-5" })).map((item) => item.id)).toEqual([SECOND_SESSION]);
    expect(items(await call(TEST_CONTEXT, "list_sessions", { from: "2026-08-17T00:00:00.000Z", to: "2026-08-17T23:59:59.000Z" })).map((item) => item.id))
      .toEqual([TEST_SESSION.id]);
  });

  it("returns summaries, never turns", async () => {
    const [first] = items(await call(TEST_CONTEXT, "list_sessions"));
    expect(first).toHaveProperty("turnCount");
    expect(first, "a browse result must not carry transcript text").not.toHaveProperty("turns");
  });

  it("cannot see the other account's session, and it cannot see mine", async () => {
    const mine = items(await call(TEST_CONTEXT, "list_sessions", { limit: 100 })).map((item) => item.id);
    const theirs = items(await call(OTHER_CONTEXT, "list_sessions", { limit: 100 })).map((item) => item.id);
    expect(mine).not.toContain(THEIR_SESSION);
    expect(theirs).toEqual([THEIR_SESSION]);
  });
});

describe("search_sessions filters", () => {
  /// `skill/SKILL.md` has told agents to pass "relevant project, agent, machine,
  /// or date filters" since the tool existed. The handler read query, mode and
  /// limit and passed `{}` as the filter, so every one of those was ignored.
  it("narrows by agent, workspace and date instead of ignoring them", async () => {
    const all = await call(TEST_CONTEXT, "search_sessions", { query: "archive", limit: 50 });
    expect(items(all).length).toBeGreaterThan(1);

    const byWorkspace = await call(TEST_CONTEXT, "search_sessions", { query: "archive", workspace: "/workspace/other" });
    expect(items(byWorkspace).map((item) => item.id)).toEqual([SECOND_SESSION]);

    const byAgent = await call(TEST_CONTEXT, "search_sessions", { query: "archive", agent: "goose" });
    expect(items(byAgent).map((item) => item.id)).toEqual([LONG_SESSION]);

    const byDate = await call(TEST_CONTEXT, "search_sessions", {
      query: "archive", from: "2026-08-18T00:00:00.000Z", to: "2026-08-18T23:59:59.000Z",
    });
    expect(items(byDate).map((item) => item.id)).toEqual([SECOND_SESSION]);
  });
});

describe("list_machines", () => {
  it("lists this account's machines so a machineId can be resolved", async () => {
    const page = await call(TEST_CONTEXT, "list_machines");
    expect(items(page).map((item) => item.name).sort()).toEqual(["laptop", "workshop"]);
    expect(page.total).toBe(2);
    // The counts are per machine and source, from the sessions themselves.
    expect(items(page).find((item) => item.name === "workshop")).toMatchObject({ platform: "macos", id: MACHINE });
  });

  it("keeps two accounts' machines apart even when a machine id is reused", async () => {
    // OTHER_MACHINE exists in both accounts on purpose: the row is keyed by
    // tenant, and a tool reading across tenants would return both.
    const theirs = items(await call(OTHER_CONTEXT, "list_machines"));
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.id).toBe(OTHER_MACHINE);
    expect(items(await call(TEST_CONTEXT, "list_machines"))).toHaveLength(2);
  });
});

describe("list_annotations and add_annotation", () => {
  it("reads back what save_note and add_annotation wrote", async () => {
    const page = await call(TEST_CONTEXT, "list_annotations", { sessionId: TEST_SESSION.id });
    expect(items(page).map((item) => item.kind)).toContain("tag");
    expect(page.total).toBeGreaterThan(0);
  });

  it("writes a tag with the provenance stamped by the tool, not by the caller", async () => {
    const created = await call(TEST_CONTEXT, "add_annotation", {
      sessionId: TEST_SESSION.id, kind: "summary", value: { markdown: "One paragraph.", source: "pretending-to-be-the-ui" },
    });
    const annotation = created.annotation as { kind: string; value: Record<string, unknown> };
    expect(annotation.kind).toBe("summary");
    expect(annotation.value.source, "a caller cannot claim to be something other than MCP").toBe("mcp");
  });

  it("refuses the annotation kinds that gate a redaction review", async () => {
    await expect(call(TEST_CONTEXT, "add_annotation", { sessionId: TEST_SESSION.id, kind: "redaction_mask", value: { start: 0, end: 5 } }))
      .rejects.toThrow(/invalid_arguments:kind/u);
    await expect(call(TEST_CONTEXT, "add_annotation", { sessionId: TEST_SESSION.id, kind: "collection", value: {} }))
      .rejects.toThrow(/invalid_arguments:kind/u);
  });

  it("bounds one annotation body on the way in and on the way out", async () => {
    await expect(call(TEST_CONTEXT, "add_annotation", { sessionId: TEST_SESSION.id, kind: "note", value: { markdown: "y".repeat(9_000) } }))
      .rejects.toThrow(/invalid_arguments:value/u);

    await call(TEST_CONTEXT, "add_annotation", { sessionId: SECOND_SESSION, kind: "note", value: { markdown: "y".repeat(5_000) } });
    const page = await call(TEST_CONTEXT, "list_annotations", { sessionId: SECOND_SESSION, maxValueChars: 500 });
    const [only] = items(page);
    expect(only!.valueTruncated).toBe(true);
    expect(only!.value, "an unparseable half of a JSON object is worse than none").toBeNull();
    expect(only!.valuePreview).toHaveLength(500);
  });

  it("cannot read or write annotations on the other account's session", async () => {
    const mine = items(await call(TEST_CONTEXT, "list_annotations", { limit: 200 }));
    expect(mine.map((item) => item.sessionId)).not.toContain(THEIR_SESSION);
    expect(items(await call(OTHER_CONTEXT, "list_annotations", { sessionId: TEST_SESSION.id }))).toEqual([]);

    // The write is refused outright: the session the annotation names does not
    // exist inside the other tenant, which is the only answer it should get.
    await expect(call(OTHER_CONTEXT, "add_annotation", { sessionId: TEST_SESSION.id, kind: "tag", value: { tag: "planted" } }))
      .rejects.toThrow(/session_not_found/u);
    const after = items(await call(TEST_CONTEXT, "list_annotations", { sessionId: TEST_SESSION.id, limit: 200 }));
    expect(after.map((item) => (item.value as Record<string, unknown> | null)?.tag), "a write from another tenant must not land in mine")
      .not.toContain("planted");
  });
});

describe("collection tools", () => {
  it("creates a collection, lists what is in one, and moves sessions in and out", async () => {
    const created = await call(TEST_CONTEXT, "create_collection", { name: "ingest", description: "How ingest was decided." });
    const collectionId = (created.collection as { id: string }).id;
    expect((created.collection as { sessionCount: number }).sessionCount).toBe(0);

    await call(TEST_CONTEXT, "add_session_to_collection", { collectionId, sessionId: TEST_SESSION.id });
    expect(items(await call(TEST_CONTEXT, "list_collection_sessions", { collectionId })).map((item) => item.id))
      .toEqual([TEST_SESSION.id]);

    await call(TEST_CONTEXT, "remove_session_from_collection", { collectionId, sessionId: TEST_SESSION.id });
    expect(items(await call(TEST_CONTEXT, "list_collection_sessions", { collectionId }))).toEqual([]);
  });

  it("pages a collection and reports the whole of it", async () => {
    await call(TEST_CONTEXT, "add_session_to_collection", { collectionId: MY_COLLECTION, sessionId: SECOND_SESSION });
    const page = await call(TEST_CONTEXT, "list_collection_sessions", { collectionId: MY_COLLECTION, limit: 1 });
    expect(items(page)).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(items(await call(TEST_CONTEXT, "list_collection_sessions", { collectionId: MY_COLLECTION, limit: 1, offset: 1 }))).toHaveLength(1);
  });

  it("cannot read or alter the other account's identically named collection", async () => {
    await expect(call(TEST_CONTEXT, "list_collection_sessions", { collectionId: THEIR_COLLECTION }))
      .rejects.toThrow(/not found/iu);
    await expect(call(TEST_CONTEXT, "add_session_to_collection", { collectionId: THEIR_COLLECTION, sessionId: TEST_SESSION.id }))
      .rejects.toThrow(/not found/iu);
    // Nor can their session be filed into mine.
    await expect(call(TEST_CONTEXT, "add_session_to_collection", { collectionId: MY_COLLECTION, sessionId: THEIR_SESSION }))
      .rejects.toThrow(/not found/iu);
    expect(items(await call(OTHER_CONTEXT, "list_collection_sessions", { collectionId: THEIR_COLLECTION })).map((item) => item.id))
      .toEqual([THEIR_SESSION]);
  });
});
