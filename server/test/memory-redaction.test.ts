import type { HttpException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { McpMemoryTools } from "../src/mcp/memory-tools.js";
import { MemoryService } from "../src/memory/memory.service.js";
import { TEST_CONTEXT } from "./fixtures/archive.js";

const MACHINE = "0191cafe-0000-7000-8000-0000000000b1";
const SECRET = "The staging key is sk_live_0123456789abcdefghij and it works.";

let store: DevArchiveStore;
let memory: MemoryService;
let tools: McpMemoryTools;

beforeEach(() => {
  store = new DevArchiveStore();
  memory = new MemoryService(store);
  tools = new McpMemoryTools(memory);
});

/**
 * The problem document a refusal carries.
 *
 * Nest renders an object body as the bare string "Conflict Exception" in the
 * error's message, so asserting on the message would assert on nothing: the
 * code is the part a client reads and the part that must not drift.
 */
async function refusal(call: Promise<unknown>): Promise<{ code?: string; redactionFindings?: string[] }> {
  try {
    await call;
  } catch (error) {
    const response = (error as HttpException).getResponse?.();
    if (response && typeof response === "object") return response;
    return { code: String(response) };
  }
  throw new Error("expected the call to be refused, and it was not");
}

function capture(text: string, overrides: Record<string, unknown> = {}, context: TenantContext = TEST_CONTEXT) {
  return memory.capture(context, {
    scope: "project",
    machineId: MACHINE,
    workspacePath: "/workspace/memoar",
    path: "/workspace/memoar/CLAUDE.md",
    readers: ["claude-code"],
    text,
    capturedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  });
}

/**
 * Memory files are where people write credentials.
 *
 * They were captured, hashed and stored, and nothing ever looked at what was in
 * them: `IngestPipeline` ran the secret scanner over every uploaded transcript
 * while `captureMemoryDocument` ran it over nothing. Redaction matters more
 * here than on a transcript, because unlike a transcript nobody re-reads a
 * CLAUDE.md before it is passed on.
 */
describe("the secret scanner over a captured memory file", () => {
  it("records what it found, and records nothing when there is nothing", async () => {
    const clean = await capture("Small files. Real coverage.", { path: "/workspace/memoar/AGENTS.md" });
    expect(clean.document.redactionStatus).toBe("clear");
    expect(clean.document.redactionFindings).toEqual([]);

    const leaky = await capture(SECRET);
    expect(leaky.document.redactionStatus).toBe("findings");
    expect(leaky.document.redactionFindings).toEqual(["api_key"]);
  });

  it("scans with the tenant's own patterns rather than a second hardcoded list", async () => {
    // emailScan is off by default, so an address is not a finding...
    const before = await capture("Ask ada@example.com before changing this.");
    expect(before.document.redactionStatus).toBe("clear");

    // ...and turning it on is a setting that has to actually reach the scanner.
    // `redactionPatterns` exists because these switches were stored, echoed back
    // and read by nothing at all.
    const settings = await store.getTenantSettings(TEST_CONTEXT);
    await store.saveTenantSettings(TEST_CONTEXT, { ...settings, redaction: { ...settings.redaction, emailScan: true } });

    const after = await capture("Ask ada@example.com before changing this.", { path: "/workspace/memoar/AGENTS.md" });
    expect(after.document.redactionStatus).toBe("findings");
    expect(after.document.redactionFindings).toEqual(["email"]);
  });

  it("keeps a completed review across an unchanged capture, and drops it when the file changes", async () => {
    // The agent re-reads these on a timer. A review undone every few minutes is
    // not a review — but a review of text that has since been edited is worse,
    // because it says a person looked at something they never saw.
    const first = await capture(SECRET);
    const reviewed = await memory.review(TEST_CONTEXT, first.document.id, first.document.contentHash);
    expect(reviewed.redactionStatus).toBe("reviewed");

    const unchanged = await capture(SECRET);
    expect(unchanged.revision, "an unchanged file is not news").toBeNull();
    expect(unchanged.document.redactionStatus, "the review survives a re-reading of the same text").toBe("reviewed");

    const edited = await capture(`${SECRET} And another: sk_live_zyxwvutsrqponmlkjihg.`);
    expect(edited.document.redactionStatus, "new text is new text; nobody has read this").toBe("findings");
    expect(edited.document.redactionFindings).toEqual(["api_key", "api_key"]);
  });

  it("refuses a review of a version that has already been replaced", async () => {
    const first = await capture(SECRET);
    const stale = first.document.contentHash;
    await capture(`${SECRET} Edited while you were reading.`);

    expect((await refusal(memory.review(TEST_CONTEXT, first.document.id, stale))).code).toBe("memory_review_stale");
    const current = await memory.get(TEST_CONTEXT, first.document.id);
    expect(current.document.redactionStatus, "a refused review changes nothing").toBe("findings");
  });
});

/**
 * The gate.
 *
 * An MCP client is not a person reading their own archive: it packs what it is
 * handed into a model's context and passes it on, with nobody in the loop to
 * notice the credential. Discovery still works, because an agent that cannot
 * find the document cannot tell its human which file needs reviewing.
 */
describe("a flagged memory file over MCP", () => {
  it("does not serve its text until a person has reviewed it", async () => {
    const captured = await capture(SECRET);
    const documentId = captured.document.id;

    const blocked = await refusal(tools.call(TEST_CONTEXT, "get_memory_document", { documentId }));
    expect(blocked.code, "the same vocabulary sharing a session already refuses in").toBe("redaction_review_required");
    expect(blocked.redactionFindings, "and it says what it found, so the agent can relay it").toEqual(["api_key"]);

    // The listing still answers, carrying the status and what was found, so the
    // agent can say which file is blocked and why.
    const page = await tools.call(TEST_CONTEXT, "list_memory_documents", {}) as {
      items: { id: string; redactionStatus: string; redactionFindings: string[] }[];
    };
    const listed = page.items.find((item) => item.id === documentId);
    expect(listed?.redactionStatus).toBe("findings");
    expect(listed?.redactionFindings).toEqual(["api_key"]);

    await memory.review(TEST_CONTEXT, documentId, captured.document.contentHash);
    const read = await tools.call(TEST_CONTEXT, "get_memory_document", { documentId }) as { content: { text: string } };
    expect(read.content.text, "a reviewed file is a file a person has agreed may go out").toBe(SECRET);
  });

  it("serves a file the scanner cleared without asking anyone", async () => {
    const clean = await capture("Small files. Real coverage.", { path: "/workspace/memoar/AGENTS.md" });
    const read = await tools.call(TEST_CONTEXT, "get_memory_document", { documentId: clean.document.id }) as {
      content: { text: string };
    };
    expect(read.content.text).toBe("Small files. Real coverage.");
  });

  it("does not let one tenant's review unlock another tenant's file", async () => {
    const other: TenantContext = {
      tenantId: "0191cafe-0000-7000-8000-0000000000b2",
      userId: "0191cafe-0000-7000-8000-0000000000b3",
      scopes: ["*"],
      authType: "dev",
    };
    // The same path in both accounts on purpose: a leak reads as a collision.
    const mine = await capture(SECRET);
    const theirs = await capture(SECRET, {}, other);
    expect(theirs.document.id).not.toBe(mine.document.id);

    await memory.review(other, theirs.document.id, theirs.document.contentHash);

    await expect(memory.review(other, mine.document.id, mine.document.contentHash))
      .rejects.toThrow(/not found/iu);
    expect((await refusal(tools.call(TEST_CONTEXT, "get_memory_document", { documentId: mine.document.id }))).code)
      .toBe("redaction_review_required");
  });
});
