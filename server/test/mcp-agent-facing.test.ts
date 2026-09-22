/**
 * What a model is told, as opposed to what is true.
 *
 * Every other surface here is read by a person, who notices when an answer is
 * odd. These tools are read by something that acts on whatever it is handed, so
 * a plausible wrong answer is worse than a refusal, and a refusal nobody can
 * act on is barely better. Each case below is one of those two shapes.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { ArchivedSession, TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { McpService } from "../src/mcp.js";
import { McpMemoryTools } from "../src/mcp/memory-tools.js";
import type { McpToolRegistry } from "../src/mcp/registry.js";
import type { MemoryService } from "../src/memory/memory.service.js";
import { seedMachine, TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { buildRegistry, items, seedArchive } from "./mcp-fixture.js";

const LONG_TURN_SESSION = "0191cafe-0000-7000-8000-0000000009a1";
const FLAGGED_MACHINE = "0191cafe-0000-7000-8000-0000000009b1";

const store = new DevArchiveStore();
let tools: McpToolRegistry;

function call(context: TenantContext, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return tools.call(context, name, args);
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the call was expected to fail and did not");
}

/** A session whose first turn alone overruns the smallest excerpt budget. */
function longTurnSession(): ArchivedSession {
  const base = structuredClone(TEST_SESSION);
  return {
    ...base,
    id: LONG_TURN_SESSION,
    title: "A session with one very long opening turn",
    turns: [
      { ...base.turns[0]!, blocks: [{ ...base.turns[0]!.blocks[0]!, text: "q".repeat(600) }] },
      { ...base.turns[1]!, blocks: [{ ...base.turns[1]!.blocks[0]!, text: "the second turn, which no 200-character budget reaches" }] },
    ],
  };
}

beforeAll(async () => {
  tools = buildRegistry(store);
  await seedArchive(store);
  await store.saveSession(TEST_CONTEXT, longTurnSession());
  await seedMachine(store, TEST_CONTEXT, FLAGGED_MACHINE, "flagged");
});

describe("search_sessions truncation", () => {
  /*
    `searchResponseBody` sends `nextCursor: null` because /search ranks rather
    than pages. On this surface that field is a sentence, and `list_sessions`
    and `get_session` both use it to mean "that was the last of them" — so a
    model that asked one bare question received ten of four hundred matches
    beside an assertion that there were no more.
  */
  it("says the ranking was cut instead of claiming there is nothing after it", async () => {
    const cut = await call(TEST_CONTEXT, "search_sessions", { query: "archive", limit: 2 });
    expect(items(cut)).toHaveLength(2);
    expect(cut.truncated, "a full page of a ranked, uncursored search means matches were dropped").toBe(true);
    expect(cut.returned).toBe(2);
    expect(cut.limit).toBe(2);
    expect(cut, "there is no cursor to offer, so none is claimed").not.toHaveProperty("nextCursor");
  });

  it("does not cry truncation when the whole match fits", async () => {
    const whole = await call(TEST_CONTEXT, "search_sessions", { query: "archive", limit: 50 });
    expect(items(whole).length).toBeGreaterThan(1);
    expect(items(whole).length).toBeLessThan(50);
    expect(whole.truncated).toBe(false);
    expect(whole.returned).toBe(items(whole).length);
  });

  it("carries the search service's honest realizedMode through unchanged", async () => {
    const result = await call(TEST_CONTEXT, "search_sessions", { query: "archive", mode: "semantic" });
    // The fixture's semantic provider is disabled, so the search falls back and
    // says so rather than presenting lexical results as semantic ones.
    expect((result.meta as Record<string, unknown>).requestedMode).toBe("semantic");
    expect((result.meta as Record<string, unknown>).realizedMode).toBe("lexical");
  });
});

describe("get_excerpt", () => {
  /*
    A span selecting no turn used to answer `{ excerpt: "", truncated: false }`
    with the requested ordinals echoed back — which reads as "that part of the
    session is empty", and is quoted onward as an absence.
  */
  it("refuses a span that selects no turn, and says how many turns there are", async () => {
    const message = await failure(call(TEST_CONTEXT, "get_excerpt", {
      sessionId: TEST_SESSION.id, turnStart: 20, turnEnd: 40,
    }));
    expect(message).toContain("empty_turn_span");
    expect(message, "the turn count is the fact that lets the caller fix the call").toContain("has 2 turns");
    expect(message).toContain("ordinals 0-1");
  });

  it("refuses a reversed span rather than answering it with nothing", async () => {
    const message = await failure(call(TEST_CONTEXT, "get_excerpt", {
      sessionId: TEST_SESSION.id, turnStart: 1, turnEnd: 0,
    }));
    expect(message).toContain("empty_turn_span");
  });

  /*
    The same citation bug `PackService.citedTurnEnd` was landed for: an excerpt
    cut at maxChars was still labelled with the last turn asked for, so an agent
    handed `turns 0-1, truncated: true` believed it had read turn 1.
  */
  it("cites the last turn whose text survived the budget, not the one asked for", async () => {
    const result = await call(TEST_CONTEXT, "get_excerpt", {
      sessionId: LONG_TURN_SESSION, turnStart: 0, turnEnd: 1, maxChars: 200,
    });
    expect(result.truncated).toBe(true);
    expect(result.turnEnd, "turn 1 is nowhere in the 200 characters returned").toBe(0);
    expect(result.requestedTurnEnd).toBe(1);
    expect(result.turnCount).toBe(2);
    expect(result.excerpt as string).not.toContain("the second turn");
  });

  it("cites the whole span when the whole span fits", async () => {
    const result = await call(TEST_CONTEXT, "get_excerpt", {
      sessionId: TEST_SESSION.id, turnStart: 0, turnEnd: 1, maxChars: 4_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.turnEnd).toBe(1);
    expect(result.turnStart).toBe(0);
  });
});

describe("argument refusals", () => {
  /*
    `invalid_arguments:sessionId` was the whole of it. Nothing in the tool's
    schema said the field had to be a uuid, so the only move left to a model
    was to send the same call again.
  */
  it("names the constraint, not only the field", async () => {
    const message = await failure(call(TEST_CONTEXT, "get_excerpt", {
      sessionId: "session-42", turnStart: 0, turnEnd: 1,
    }));
    expect(message, "clients and tests match on the prefix").toContain("invalid_arguments:sessionId");
    expect(message.toLowerCase()).toContain("uuid");
  });

  it("explains an unknown field rather than only listing it", async () => {
    const message = await failure(call(TEST_CONTEXT, "list_sessions", { pageSize: 10 }));
    expect(message).toContain("invalid_arguments:pageSize");
    expect(message).toContain("should not exist");
  });

  it("passes through the bespoke wording a DTO wrote for a caller", async () => {
    const message = await failure(call(TEST_CONTEXT, "list_memory_documents", { pathPattern: "(A|B).md" }));
    expect(message).toContain("wildcards");
  });

  it("says by how much an annotation body overran", async () => {
    const message = await failure(call(TEST_CONTEXT, "add_annotation", {
      sessionId: TEST_SESSION.id, kind: "note", value: { markdown: "y".repeat(9_000) },
    }));
    expect(message).toContain("invalid_arguments:value");
    expect(message).toContain("at most 8000");
  });
});

describe("list_annotations", () => {
  /*
    The store orders annotations oldest-first, for a web app that renders all of
    them as a thread. Over MCP the first page is usually the only page, so the
    tool that says it is "how an agent reads back what save_note wrote" answered
    a busy session with the oldest notes on it — and the note written a minute
    ago was indistinguishable, to the caller, from a write that had failed.
  */
  it("puts the note just written on the first page", async () => {
    for (const markdown of ["oldest", "middle", "newest"]) {
      await call(TEST_CONTEXT, "save_note", { sessionId: LONG_TURN_SESSION, markdown });
    }
    const page = await call(TEST_CONTEXT, "list_annotations", { sessionId: LONG_TURN_SESSION, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.order).toBe("createdAt_desc");
    expect((items(page)[0]!.value as Record<string, unknown>).markdown).toBe("newest");
  });
});

describe("tool errors as a model receives them", () => {
  /*
    A tool error is all the caller gets: no status code beside it, no body to
    inspect. Nest builds its refusals by handing an object to the exception, and
    `HttpException.initMessage` adopts only a `message` property — which an RFC
    7807 body has not got — so `error.message` was the *class name*. The one
    refusal on this surface a model can act on, by telling its human which file
    needs reviewing, arrived as the two words "Conflict Exception".
  */
  async function connected(context: TenantContext): Promise<Client> {
    const service = new McpService(tools);
    const server = service.createServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "memoar-error-shape-test", version: "0.0.1" });
    await client.connect(clientTransport);
    return client;
  }

  it("hands back the redaction gate's code and sentence, not the exception's class name", async () => {
    const { document } = await store.captureMemoryDocument(TEST_CONTEXT, {
      scope: "project",
      machineId: FLAGGED_MACHINE,
      workspacePath: "/workspace/memoar",
      path: "/workspace/memoar/FLAGGED.md",
      title: "FLAGGED.md",
      readers: ["claude"],
      contentHash: "b".repeat(64),
      text: "The staging key is sk-not-a-real-key.",
      capturedAt: "2026-08-20T00:00:00.000Z",
      visibility: { scope: "private", ownerId: TEST_CONTEXT.userId },
      redactionStatus: "findings",
      redactionFindings: ["api_key"],
    });

    const client = await connected(TEST_CONTEXT);
    const refused = await client.callTool({ name: "get_memory_document", arguments: { documentId: document.id } });
    const text = (refused.content as { text: string }[])[0]!.text;

    expect(refused.isError).toBe(true);
    expect(text, "the class name tells a model nothing it can act on").not.toBe("Conflict Exception");
    expect(text).toContain("redaction_review_required");
    expect(text, "and the sentence that says what would unblock it").toContain("has to review it");
    await client.close();
  });

  it("still carries a plain refusal through unchanged", async () => {
    const client = await connected(TEST_CONTEXT);
    const missing = await client.callTool({
      name: "get_session",
      arguments: { sessionId: "0191cafe-0000-7000-8000-00000000dead" },
    });
    expect(missing.isError).toBe(true);
    expect((missing.content as { text: string }[])[0]!.text).toContain("Session not found");
    await client.close();
  });
});

describe("get_memory_document content hash", () => {
  /*
    `currentRevision` falls back to the newest revision when the document's own
    is gone. The hash beside the text was the document's either way, so that
    fallback reported one version's text under another version's hash — the
    pairing `memory-revisions.ts` exists to stop.
  */
  it("names the revision the text actually came from", async () => {
    const orphaned = {
      get: () => Promise.resolve({
        document: { id: "d", path: "/x/CLAUDE.md", contentHash: "f".repeat(64), capturedAt: "2026-08-20T00:00:00.000Z", redactionStatus: "clear" },
        revisions: [{ id: "r-newest", documentId: "d", contentHash: "a".repeat(64), text: "what the archive still holds", size: 28, capturedAt: "2026-08-19T00:00:00.000Z" }],
      }),
    } as unknown as MemoryService;

    const result = await new McpMemoryTools(orphaned).call(TEST_CONTEXT, "get_memory_document", {
      documentId: "0191cafe-0000-7000-8000-0000000009c1",
    }) as { content: { text: string; contentHash: string; revisionId: string } };

    expect(result.content.text).toBe("what the archive still holds");
    expect(result.content.contentHash, "the hash must name the text beside it").toBe("a".repeat(64));
    expect(result.content.revisionId).toBe("r-newest");
  });
});

// The tools' descriptions and schemas are checked against their handlers in
// `mcp-tool-contracts.test.ts`, which needs no archive behind it.
