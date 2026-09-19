import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arr, obj, startTestApi, str, type TestApi } from "./helpers/http-app.js";

let api: TestApi;
const MACHINE = "0191cafe-0000-7000-8000-0000000000d1";

beforeAll(async () => { api = await startTestApi(); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

function capture(text: string, overrides: Record<string, unknown> = {}) {
  return {
    scope: "project",
    machineId: MACHINE,
    workspacePath: "/workspace/memoar",
    path: "/workspace/memoar/AGENTS.md",
    readers: ["codex", "cursor", "copilot", "roo", "zed", "opencode", "crush"],
    text,
    capturedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("memory documents over HTTP", () => {
  it("records a reading, and records nothing when the file has not changed", async () => {
    const first = await api.request("POST", "/memory", { body: capture("Small files. Real coverage.") });
    expect(first.status).toBe(200);
    expect(obj(first.body, "revision").text).toBe("Small files. Real coverage.");

    const again = await api.request("POST", "/memory", { body: capture("Small files. Real coverage.") });
    expect(again.body.revision, "the agent re-reads on a timer; unchanged is not news").toBeNull();
    expect(str(obj(again.body, "document"), "id")).toBe(str(obj(first.body, "document"), "id"));
  });

  it("hashes the text itself rather than believing the caller", async () => {
    // The hash decides whether a reading is a change. A caller that chose it
    // could hide an edit, or invent one that never happened.
    const response = await api.request("POST", "/memory", {
      body: capture("Ordinary content.", { path: "/workspace/memoar/HASH.md", contentHash: "0".repeat(64) }),
    });
    expect(response.status, "an unknown field is refused outright").toBe(400);

    const honest = await api.request("POST", "/memory", { body: capture("Ordinary content.", { path: "/workspace/memoar/HASH.md" }) });
    expect(str(obj(honest.body, "document"), "contentHash"))
      .toBe(createHash("sha256").update("Ordinary content.").digest("hex"));
  });

  it("keeps every version of a file that changed", async () => {
    const path = "/workspace/memoar/CLAUDE.md";
    await api.request("POST", "/memory", { body: capture("Rule one.", { path, capturedAt: "2026-08-19T00:00:00.000Z" }) });
    const latest = await api.request("POST", "/memory", { body: capture("Rule one. Rule two.", { path, capturedAt: "2026-08-20T00:00:00.000Z" }) });
    const documentId = str(obj(latest.body, "document"), "id");

    const read = await api.request("GET", `/memory/${documentId}`);
    expect(read.status).toBe(200);
    expect(arr(read.body, "revisions").map((revision) => revision.text))
      .toEqual(["Rule one. Rule two.", "Rule one."]);
    expect(str(obj(read.body, "document"), "title"), "the title is the file's name, taken from the path").toBe("CLAUDE.md");
  });

  it("lists what the agents on this account are being told, filtered by machine and scope", async () => {
    await api.request("POST", "/memory", { body: capture("Global preferences.", { scope: "global", path: "/Users/x/.claude/CLAUDE.md" }) });

    const all = await api.request("GET", "/memory");
    expect(arr(all.body).length).toBeGreaterThan(1);
    expect(arr(await api.request("GET", "/memory?scope=global").then((response) => response.body))
      .every((document) => document.scope === "global")).toBe(true);
    expect(arr((await api.request(`GET`, `/memory?machineId=${MACHINE}`)).body).length).toBeGreaterThan(0);
    expect(arr((await api.request("GET", "/memory?machineId=0191cafe-0000-7000-8000-0000000000d9")).body)).toEqual([]);
  });

  it("refuses a capture that is missing or malformed rather than storing nonsense", async () => {
    // Every one of these reached the store as a 500 in the past, because a body
    // typed as an interface is invisible to the validation pipe.
    for (const body of [
      {},
      capture("x", { scope: "everywhere" }),
      capture("x", { machineId: "not-a-uuid" }),
      capture("x", { path: "" }),
      capture("x", { readers: "codex" }),
      capture("x", { capturedAt: "yesterday" }),
      capture("x", { text: 42 }),
      // The title is derived from the path, so sending one is a caller that
      // believes it decides something it does not.
      capture("x", { title: "Something else" }),
    ]) {
      const response = await api.request("POST", "/memory", { body });
      expect(response.status, `accepted ${JSON.stringify(body).slice(0, 80)}`).toBe(400);
    }
  });

  it("removes a document with its whole history, and says so once", async () => {
    const created = await api.request("POST", "/memory", { body: capture("Temporary.", { path: "/workspace/memoar/TEMP.md" }) });
    const documentId = str(obj(created.body, "document"), "id");

    expect((await api.request("DELETE", `/memory/${documentId}`)).status).toBe(204);
    expect((await api.request("GET", `/memory/${documentId}`)).status).toBe(404);
    expect((await api.request("DELETE", `/memory/${documentId}`)).status).toBe(404);
  });

  it("lets the capture agent record with its machine token, but only for itself", async () => {
    // The agent holds a machine token, not a user session: if the endpoint
    // inferred archive:write from the method, the only caller there is would be
    // locked out of the feature entirely.
    const machine = await api.request("POST", "/machines", { body: { name: "memory capture", platform: "linux" } });
    const machineId = str(machine.body, "id");
    const token = str((await api.request("POST", "/auth/machine-token", { body: { machineId } })).body, "token");

    const own = await api.request("POST", "/memory", { token, body: capture("From the agent.", { machineId, path: "/workspace/memoar/OWN.md" }) });
    expect(own.status).toBe(200);
    expect(str(obj(own.body, "document"), "machineId")).toBe(machineId);

    // A document is identified by its machine and path, so filing under another
    // machine's id would merge two laptops' files into one history of edits
    // neither of them made.
    const impostor = await api.request("POST", "/memory", { token, body: capture("Not mine to file.", { machineId: MACHINE, path: "/workspace/memoar/OWN.md" }) });
    expect(impostor.status).toBe(403);

    // Reading the archive is still not part of the machine surface.
    expect((await api.request("GET", "/memory", { token })).status).toBe(403);
  });

  it("refuses to read or delete anything but a well-formed id", async () => {
    expect((await api.request("GET", "/memory/not-a-uuid")).status).toBe(400);
    expect((await api.request("DELETE", "/memory/not-a-uuid")).status).toBe(400);
  });

  /*
    Reading your own memory file in your own archive is not egress: it is the
    only place the review can happen. What the review endpoint has to do is be
    performable, be about one version of the file, and refuse everything else.
  */
  it("lets a person review what the scanner found, for the version they read", async () => {
    const path = "/workspace/memoar/SECRETS.md";
    const leaky = "The staging key is sk_live_0123456789abcdefghij.";
    const created = await api.request("POST", "/memory", { body: capture(leaky, { path }) });
    const document = obj(created.body, "document");
    const documentId = str(document, "id");
    expect(document.redactionStatus, "a captured file is scanned, not merely stored").toBe("findings");
    expect(document.redactionFindings).toEqual(["api_key"]);

    // The owner can still read it: the gate is on what leaves, not on the
    // archive the reviewer has to read in order to review.
    const read = await api.request("GET", `/memory/${documentId}`);
    expect(read.status).toBe(200);
    expect(arr(read.body, "revisions")[0]!.text).toBe(leaky);

    const contentHash = str(document, "contentHash");
    for (const body of [{}, { contentHash: "nope" }, { contentHash: "A".repeat(64) }]) {
      expect((await api.request("POST", `/memory/${documentId}/redaction-reviews`, { body })).status,
        `accepted ${JSON.stringify(body)}`).toBe(400);
    }
    // A hash that is well formed but names another version is a conflict, not a
    // malformed request: the file moved while it was being read.
    const stale = await api.request("POST", `/memory/${documentId}/redaction-reviews`, { body: { contentHash: "b".repeat(64) } });
    expect(stale.status).toBe(409);

    const reviewed = await api.request("POST", `/memory/${documentId}/redaction-reviews`, { body: { contentHash } });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.redactionStatus).toBe("reviewed");
    expect(str(obj((await api.request("GET", `/memory/${documentId}`)).body, "document"), "redactionStatus")).toBe("reviewed");

    expect((await api.request("POST", "/memory/0191cafe-0000-7000-8000-0000000000da/redaction-reviews", { body: { contentHash } })).status).toBe(404);
  });
});
