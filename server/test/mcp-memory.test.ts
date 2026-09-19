import { beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { McpMemoryTools } from "../src/mcp/memory-tools.js";
import { MemoryService } from "../src/memory/memory.service.js";
import { seedMachine, TEST_CONTEXT } from "./fixtures/archive.js";

const OTHER_CONTEXT: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000f1",
  userId: "0191cafe-0000-7000-8000-0000000000f2",
  scopes: ["*"],
  authType: "dev",
};

const MACHINE = "0191cafe-0000-7000-8000-0000000000e1";
const OTHER_MACHINE = "0191cafe-0000-7000-8000-0000000000e2";

const store = new DevArchiveStore();
const memory = new MemoryService(store);
const tools = new McpMemoryTools(memory);

function capture(context: TenantContext, path: string, text: string, overrides: Record<string, unknown> = {}) {
  return memory.capture(context, {
    scope: "project",
    machineId: MACHINE,
    workspacePath: "/workspace/memoar",
    path,
    readers: ["claude"],
    text,
    capturedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  });
}

async function list(context: TenantContext, args: Record<string, unknown> = {}) {
  const page = await tools.call(context, "list_memory_documents", args);
  return page as { items: { id: string; path: string }[]; total: number; limit: number; offset: number };
}

async function documentIdOf(path: string): Promise<string> {
  const page = await list(TEST_CONTEXT, { pathPattern: path });
  const found = page.items.find((item) => item.path === path);
  if (!found) throw new Error(`fixture missing: ${path}`);
  return found.id;
}

beforeAll(async () => {
  // Both accounts register the machine ids they file under: a capture resolves
  // one now, so a fixture that invented one would be testing the refusal.
  await seedMachine(store, TEST_CONTEXT, MACHINE, "workshop");
  await seedMachine(store, TEST_CONTEXT, OTHER_MACHINE, "laptop");
  await seedMachine(store, OTHER_CONTEXT, MACHINE, "their-workshop");
  await capture(TEST_CONTEXT, "/workspace/memoar/CLAUDE.md", "Rule one.", { capturedAt: "2026-08-18T00:00:00.000Z" });
  await capture(TEST_CONTEXT, "/workspace/memoar/CLAUDE.md", "Rule one. Rule two.", { capturedAt: "2026-08-19T00:00:00.000Z" });
  await capture(TEST_CONTEXT, "/workspace/memoar/AGENTS.md", "Small files.");
  await capture(TEST_CONTEXT, "/workspace/memoar/docs/C(1).md", "A parenthesis in a name.");
  await capture(TEST_CONTEXT, "/workspace/other/AGENTS.md", "Another project.", { workspacePath: "/workspace/other" });
  await capture(TEST_CONTEXT, "/Users/frane/.claude/CLAUDE.md", "Global preferences.", { scope: "global", workspacePath: undefined });
  await capture(TEST_CONTEXT, "/workspace/memoar/GEMINI.md", "From the other laptop.", { machineId: OTHER_MACHINE });
  await capture(TEST_CONTEXT, "/workspace/memoar/LONG.md", "y".repeat(5_000));
  // Another account's file, captured with the same path on purpose: if the
  // tools ever read outside the tenant it will surface here rather than in
  // production.
  await capture(OTHER_CONTEXT, "/workspace/memoar/CLAUDE.md", "Not yours to read.");
});

describe("memory documents over MCP", () => {
  it("lists the captured instruction files, newest filters and all", async () => {
    const page = await list(TEST_CONTEXT);
    expect(page.items.map((item) => item.path)).toContain("/workspace/memoar/CLAUDE.md");
    expect(page.total).toBe(7);
    expect(page.limit).toBe(25);
    expect(page.offset).toBe(0);
  });

  it("filters by machine, scope, workspace and file name", async () => {
    expect((await list(TEST_CONTEXT, { machineId: OTHER_MACHINE })).items.map((item) => item.path))
      .toEqual(["/workspace/memoar/GEMINI.md"]);
    expect((await list(TEST_CONTEXT, { scope: "global" })).items.map((item) => item.path))
      .toEqual(["/Users/frane/.claude/CLAUDE.md"]);
    expect((await list(TEST_CONTEXT, { workspacePath: "/workspace/other" })).items.map((item) => item.path))
      .toEqual(["/workspace/other/AGENTS.md"]);

    // A bare file name is what a person means, and so is a path glob.
    expect((await list(TEST_CONTEXT, { pathPattern: "AGENTS.md" })).items.map((item) => item.path))
      .toEqual(["/workspace/memoar/AGENTS.md", "/workspace/other/AGENTS.md"]);
    expect((await list(TEST_CONTEXT, { pathPattern: "*.md" })).total).toBe(7);
    // `*` spans separators, so a directory prefix selects everything under it.
    expect([...(await list(TEST_CONTEXT, { pathPattern: "/workspace/memoar/*.md" })).items.map((item) => item.path)].sort())
      .toEqual([
        "/workspace/memoar/AGENTS.md",
        "/workspace/memoar/CLAUDE.md",
        "/workspace/memoar/GEMINI.md",
        "/workspace/memoar/LONG.md",
        "/workspace/memoar/docs/C(1).md",
      ]);
    expect((await list(TEST_CONTEXT, { pathPattern: "CLAUD?.md" })).items.map((item) => item.path))
      .toEqual(["/Users/frane/.claude/CLAUDE.md", "/workspace/memoar/CLAUDE.md"]);
    expect((await list(TEST_CONTEXT, { pathPattern: "NOTHING.md" })).items).toEqual([]);
  });

  it("treats a pattern as a pattern over names, not as a regular expression", async () => {
    // The characters are legal in a path, so they match themselves; a pattern
    // compiled without escaping would read this as a group and match nothing.
    expect((await list(TEST_CONTEXT, { pathPattern: "C(1).md" })).items.map((item) => item.path))
      .toEqual(["/workspace/memoar/docs/C(1).md"]);
  });

  it("pages within bounds and reports the full size of the match", async () => {
    const first = await list(TEST_CONTEXT, { limit: 2 });
    const second = await list(TEST_CONTEXT, { limit: 2, offset: 2 });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(first.total).toBe(7);
    expect(second.offset).toBe(2);
    expect(second.items.map((item) => item.id)).not.toEqual(first.items.map((item) => item.id));
    expect((await list(TEST_CONTEXT, { limit: 2, offset: 6 })).items).toHaveLength(1);
  });

  /// The text a reverted file reports is the text the file actually holds.
  ///
  /// A revert reuses the revision already recorded for that text — deliberately,
  /// because it is the same text — so the reused row keeps its original
  /// `capturedAt` and the newest-first history no longer starts with the
  /// current version. Taking the head returned the abandoned text beside the
  /// current hash, which is two versions presented as one.
  it("reports what a reverted file says now, not the version it was reverted away from", async () => {
    const path = "/workspace/memoar/REVERTED.md";
    await capture(TEST_CONTEXT, path, "First rule.", { capturedAt: "2026-08-10T00:00:00.000Z" });
    await capture(TEST_CONTEXT, path, "Second rule.", { capturedAt: "2026-08-11T00:00:00.000Z" });
    await capture(TEST_CONTEXT, path, "First rule.", { capturedAt: "2026-08-12T00:00:00.000Z" });

    const documentId = await documentIdOf(path);
    const result = await tools.call(TEST_CONTEXT, "get_memory_document", { documentId }) as {
      content: { text: string; contentHash: string };
      revisions: { contentHash: string; capturedAt: string }[];
    };

    expect(result.content.text, "the file was reverted to its first text").toBe("First rule.");
    // The bug that motivates this test was not a wrong hash but a hash that did
    // not belong to the text beside it, so the pair is what gets asserted.
    const matching = result.revisions.find(
      (revision) => revision.contentHash === result.content.contentHash,
    );
    expect(matching, "the reported hash must name a revision that exists").toBeDefined();
    expect(result.revisions[0]?.contentHash).not.toBe(result.content.contentHash);
  });

  it("refuses arguments it cannot vouch for rather than guessing", async () => {
    for (const args of [
      { limit: 0 },
      { limit: 101 },
      { limit: 10.5 },
      { limit: "10" },
      { offset: -1 },
      { offset: 10_001 },
      { machineId: "not-a-uuid" },
      { scope: "everywhere" },
      { workspacePath: "x".repeat(4097) },
      { pathPattern: "" },
      { pathPattern: "a".repeat(201) },
      // Alternation and quantifiers are not path characters; refused before
      // anything tries to compile them.
      { pathPattern: "(CLAUDE|AGENTS).md" },
      { pathPattern: "^(a+)+$" },
      { unknownField: true },
    ]) {
      await expect(tools.call(TEST_CONTEXT, "list_memory_documents", args), `accepted ${JSON.stringify(args)}`)
        .rejects.toThrow(/invalid_arguments/u);
    }

    for (const args of [
      {},
      { documentId: "not-a-uuid" },
      { documentId: TEST_CONTEXT.tenantId, maxChars: 199 },
      { documentId: TEST_CONTEXT.tenantId, maxChars: 200_001 },
      { documentId: TEST_CONTEXT.tenantId, maxRevisions: 0 },
      { documentId: TEST_CONTEXT.tenantId, maxRevisions: 51 },
      { documentId: TEST_CONTEXT.tenantId, extra: 1 },
    ]) {
      await expect(tools.call(TEST_CONTEXT, "get_memory_document", args), `accepted ${JSON.stringify(args)}`)
        .rejects.toThrow(/invalid_arguments/u);
    }
  });

  it("reads one document with its current text and how it changed", async () => {
    const documentId = await documentIdOf("/workspace/memoar/CLAUDE.md");
    const result = await tools.call(TEST_CONTEXT, "get_memory_document", { documentId }) as {
      document: { path: string; title: string };
      content: { text: string; truncated: boolean; contentHash: string };
      revisions: { capturedAt: string; size: number; text?: string }[];
      revisionCount: number;
    };

    expect(result.document.path).toBe("/workspace/memoar/CLAUDE.md");
    expect(result.document.title).toBe("CLAUDE.md");
    expect(result.content.text, "the newest revision is what the file says now").toBe("Rule one. Rule two.");
    expect(result.content.truncated).toBe(false);
    expect(result.revisionCount).toBe(2);
    expect(result.revisions.map((revision) => revision.capturedAt))
      .toEqual(["2026-08-19T00:00:00.000Z", "2026-08-18T00:00:00.000Z"]);
    // History is metadata: one call must not return every version of a long file.
    expect(result.revisions.every((revision) => revision.text === undefined)).toBe(true);
  });

  it("bounds the text it returns and says when it cut it", async () => {
    const documentId = await documentIdOf("/workspace/memoar/AGENTS.md");
    const result = await tools.call(TEST_CONTEXT, "get_memory_document", { documentId, maxChars: 200 }) as {
      content: { text: string; truncated: boolean };
    };
    expect(result.content.text).toBe("Small files.");
    expect(result.content.truncated).toBe(false);

    const longId = await documentIdOf("/workspace/memoar/LONG.md");
    const cut = await tools.call(TEST_CONTEXT, "get_memory_document", { documentId: longId, maxChars: 200 }) as {
      content: { text: string; truncated: boolean };
    };
    expect(cut.content.text).toHaveLength(200);
    expect(cut.content.truncated).toBe(true);
  });

  it("keeps only the newest revisions asked for", async () => {
    const documentId = await documentIdOf("/workspace/memoar/CLAUDE.md");
    const result = await tools.call(TEST_CONTEXT, "get_memory_document", { documentId, maxRevisions: 1 }) as {
      revisions: { capturedAt: string }[];
      revisionCount: number;
    };
    expect(result.revisions.map((revision) => revision.capturedAt)).toEqual(["2026-08-19T00:00:00.000Z"]);
    expect(result.revisionCount, "the count is of what exists, not of what was returned").toBe(2);
  });

  it("cannot reach another account's document, by id or by listing", async () => {
    const mine = await documentIdOf("/workspace/memoar/CLAUDE.md");
    const theirs = (await list(OTHER_CONTEXT)).items;

    // Same path, same machine, different account: two distinct documents.
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.id).not.toBe(mine);

    await expect(tools.call(OTHER_CONTEXT, "get_memory_document", { documentId: mine }))
      .rejects.toThrow(/not found/iu);
    await expect(tools.call(TEST_CONTEXT, "get_memory_document", { documentId: theirs[0]!.id }))
      .rejects.toThrow(/not found/iu);

    // And nothing of theirs leaks into a listing of mine, however it is filtered.
    const everything = await list(TEST_CONTEXT, { limit: 100 });
    expect(everything.items.map((item) => item.id)).not.toContain(theirs[0]!.id);
    const byPath = await list(TEST_CONTEXT, { pathPattern: "/workspace/memoar/CLAUDE.md" });
    expect(byPath.items.map((item) => item.id)).toEqual([mine]);

    const theirText = await tools.call(OTHER_CONTEXT, "get_memory_document", { documentId: theirs[0]!.id }) as {
      content: { text: string };
    };
    expect(theirText.content.text).toBe("Not yours to read.");
  });
});
