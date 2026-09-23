/**
 * The same credential, the same answer, on both surfaces.
 *
 * `inferredScopes` prices any path containing `/mcp` at `mcp:use`, and every
 * write tool was gated on that and nothing else. A key created the way
 * `docs/mcp.md` recommended — `mcp:use`, nothing more — was refused
 * `POST /v1/annotations` with a 403 and granted `add_annotation` over MCP. One
 * credential, one write, two answers.
 *
 * The obvious fix was blocked: the handshake minted `mcp:use` alone, so gating
 * the write tools on archive:write would have broken every Codex client. So the
 * handshake now passes on the key's own scopes and never invents one, and the
 * tools are gated per tool against the route each wraps.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inferredScopes } from "../src/auth/auth.guard.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { assertToolScopes, IMPLIED_BY_MCP_USE, MCP_TOOL_GATES, mcpTokenScopes } from "../src/mcp/tool-scopes.js";
import { TokenService } from "../src/auth/tokens.js";
import { buildRegistry } from "./mcp-fixture.js";
import { FIXTURE_SESSION_ID, startTestApi, str, type TestApi } from "./helpers/http-app.js";

const registry = buildRegistry(new DevArchiveStore());

describe("the tool-to-scope table", () => {
  it("covers every tool the registry serves, and nothing else", () => {
    // A tool wired in and left out of the table is the one tool with no gate.
    // `assertToolScopes` refuses it at runtime; this says so at build time.
    expect([...registry.names].sort()).toEqual(Object.keys(MCP_TOOL_GATES).sort());
    expect(registry.names).toHaveLength(20);
  });

  /*
    The assertion the whole change rests on.

    Not a second copy of the mapping — the expectation is computed by the
    guard's own `inferredScopes` against the route each tool wraps. A tool
    added later and gated on less than its HTTP equivalent fails here, and so
    does one whose route stops being priced the way it was.
  */
  it("charges every tool exactly what its HTTP route charges, plus mcp:use", () => {
    for (const [name, gate] of Object.entries(MCP_TOOL_GATES)) {
      const http = inferredScopes({ headers: {}, method: gate.route.method, url: gate.route.path });
      expect(gate.scopes, `${name} wraps ${gate.route.method} ${gate.route.path}`).toEqual(["mcp:use", ...http]);
    }
  });

  it("puts archive:write on every tool that writes, and on no tool that does not", () => {
    const writing = Object.entries(MCP_TOOL_GATES)
      .filter(([, gate]) => gate.scopes.includes("archive:write"))
      .map(([name]) => name)
      .sort();
    // The five tools the finding named. Reading tools are absent on purpose:
    // `pack` and `export_project_memory` are POSTs that store nothing.
    expect(writing).toEqual([
      "add_annotation", "add_session_to_collection", "create_collection",
      "remove_session_from_collection", "save_note",
    ]);
  });
});

/**
 * The one place this surface is priced differently from HTTP.
 *
 * Reading the archive is what `mcp:use` is for, and it is the key `docs/mcp.md`
 * has always told people to create, so holding it satisfies `archive:read` for
 * a tool call. The defect being closed is a *write* the credential was refused
 * on every other surface, so the allowance stops there — and these assertions
 * are what stops somebody widening it later by one word.
 */
describe("the allowance that mcp:use reads", () => {
  const mcpOnlyContext = { tenantId: "t", userId: "u", scopes: ["mcp:use"], authType: "api_key" as const };

  it("covers reads and, tool by tool, never a write", () => {
    for (const [name, gate] of Object.entries(MCP_TOOL_GATES)) {
      if (gate.scopes.includes("archive:write")) {
        // The whole point. Extending IMPLIED_BY_MCP_USE to archive:write makes
        // every one of these stop throwing, and this test go red.
        expect(() => assertToolScopes(mcpOnlyContext, name), `${name} writes and was allowed on mcp:use alone`).toThrow();
      } else {
        expect(() => assertToolScopes(mcpOnlyContext, name), `${name} only reads and was refused`).not.toThrow();
      }
    }
  });

  it("is one scope, stated once, and not a write", () => {
    expect(IMPLIED_BY_MCP_USE).toEqual(["archive:read"]);
    expect(IMPLIED_BY_MCP_USE.filter((scope) => scope.endsWith(":write"))).toEqual([]);
  });

  it("does not leak onto the HTTP surface", () => {
    // `inferredScopes` is untouched: the same key is still refused the write
    // route, which is the asymmetry this whole change exists to remove.
    expect(inferredScopes({ headers: {}, method: "POST", url: "/v1/annotations" })).toEqual(["archive:write"]);
    expect(inferredScopes({ headers: {}, method: "GET", url: "/v1/sessions" })).toEqual(["archive:read"]);
  });
});

describe("the handshake's grant", () => {
  it("is the exchanged credential's own scopes, never more", () => {
    expect(mcpTokenScopes(["mcp:use"])).toEqual(["mcp:use"]);
    expect(mcpTokenScopes(["mcp:use", "archive:read"])).toEqual(["mcp:use", "archive:read"]);
    expect(mcpTokenScopes(["mcp:use", "archive:read", "archive:write"])).toEqual(["mcp:use", "archive:read", "archive:write"]);
    // Scopes MCP cannot spend are not carried into a token handed to another
    // program: a key that may mint credentials does not mint them through MCP.
    expect(mcpTokenScopes(["mcp:use", "keys:write", "machines:write"])).toEqual(["mcp:use"]);
    // The development wildcard becomes this list rather than the wildcard.
    expect(mcpTokenScopes(["*"])).toEqual(["mcp:use", "archive:read", "archive:write"]);
  });
});

describe("an mcp:use key on both surfaces", () => {
  let api: TestApi;
  let mcpOnly: string;
  let writer: string;
  let reader: string;

  async function key(name: string, scopes: string[]): Promise<string> {
    return str((await api.request("POST", "/auth/api-keys", { body: { name, scopes } })).body, "secret");
  }

  /** One tool call over the real transport, as the API key that holds `key`. */
  async function tool(apiKey: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const response = await fetch(`${api.baseUrl}/mcp`, {
      method: "POST",
      headers: { "x-memoar-key": apiKey, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = JSON.parse(await response.text()) as { result: { isError?: boolean; content: { text: string }[] } };
    return { isError: body.result.isError === true, text: body.result.content[0]!.text };
  }

  beforeAll(async () => {
    api = await startTestApi();
    mcpOnly = await key("mcp only", ["mcp:use"]);
    reader = await key("reader", ["mcp:use", "archive:read"]);
    writer = await key("curator", ["mcp:use", "archive:read", "archive:write"]);
  }, 30_000);

  afterAll(async () => { if (api) await api.close(); });

  it("is refused the write on HTTP and refused it over MCP too", async () => {
    const http = await api.request("POST", "/annotations", {
      token: null,
      headers: { "x-memoar-key": mcpOnly },
      body: { sessionId: FIXTURE_SESSION_ID, kind: "note", value: { markdown: "over http" } },
    });
    expect(http.status, "the HTTP half of the asymmetry").toBe(403);

    const call = await tool(mcpOnly, "add_annotation", { sessionId: FIXTURE_SESSION_ID, kind: "tag", value: { tag: "over mcp" } });
    expect(call.isError, "the same credential wrote the same annotation through the other door").toBe(true);
    // A model that cannot tell "you may not" from "that failed" retries. The
    // refusal names the scope, and says not to.
    expect(call.text).toContain("missing_scope:");
    expect(call.text).toContain("archive:write");
    expect(call.text).toContain("Do not retry");

    // And nothing landed: the refusal is before the service, not after it.
    const annotations = await api.request("GET", `/annotations?sessionId=${FIXTURE_SESSION_ID}`);
    const tags = (annotations.body.items as { value: { tag?: string } }[]).map((item) => item.value.tag);
    expect(tags).not.toContain("over mcp");
  });

  it("keeps every write tool shut, not just the one", async () => {
    for (const [name, args] of [
      ["save_note", { sessionId: FIXTURE_SESSION_ID, markdown: "note" }],
      ["create_collection", { name: "should not exist" }],
      ["add_session_to_collection", { collectionId: FIXTURE_SESSION_ID, sessionId: FIXTURE_SESSION_ID }],
      ["remove_session_from_collection", { collectionId: FIXTURE_SESSION_ID, sessionId: FIXTURE_SESSION_ID }],
    ] as const) {
      const call = await tool(mcpOnly, name, args);
      expect(call.text, `${name} was gated on mcp:use alone`).toContain("missing_scope:");
    }
    expect((await api.request("GET", "/collections")).body.items).toEqual([]);
  });

  /*
    And keeps every read, which is the half that must not break.

    `mcp:use` is the key this page has told people to create since the endpoint
    existed, and reading the archive is what the scope is for. Withdrawing that
    from every client at once would be a migration; refusing the five writes
    needs none, because no other surface ever granted them.
  */
  it("reads the archive over MCP on mcp:use alone", async () => {
    for (const [name, args] of [
      ["search_sessions", { query: "archive" }],
      ["list_sessions", {}],
      ["get_session", { sessionId: FIXTURE_SESSION_ID }],
      ["get_excerpt", { sessionId: FIXTURE_SESSION_ID, turnStart: 0, turnEnd: 1 }],
      ["pack", { query: "archive", maxTokens: 500, maxEvidence: 2, maxSessions: 2, maxExcerptChars: 500, freshnessPolicy: "mixed" }],
      ["get_memory", { topic: "archive" }],
      ["list_annotations", {}],
      ["list_collections", {}],
      ["list_machines", {}],
      ["list_share_links", {}],
      ["list_transfers", {}],
      ["list_memory_documents", {}],
      ["export_project_memory", { workspace: "/workspace/demo" }],
    ] as const) {
      const call = await tool(mcpOnly, name, args);
      expect(call.isError, `${name}: ${call.text}`).toBe(false);
    }
    const search = await tool(mcpOnly, "search_sessions", { query: "archive" });
    expect(search.text, "a read that returned nothing is not a read").toContain(FIXTURE_SESSION_ID);
  });

  it("still opens MCP itself, so the refusal is a scope and not a closed door", async () => {
    const response = await fetch(`${api.baseUrl}/mcp`, {
      method: "POST",
      headers: { "x-memoar-key": mcpOnly, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
  });

  it("lets a key that legitimately holds archive:write through on both surfaces", async () => {
    const call = await tool(writer, "add_annotation", { sessionId: FIXTURE_SESSION_ID, kind: "tag", value: { tag: "allowed" } });
    expect(call.isError, call.text).toBe(false);
    const http = await api.request("POST", "/annotations", {
      token: null,
      headers: { "x-memoar-key": writer },
      body: { sessionId: FIXTURE_SESSION_ID, kind: "note", value: { markdown: "allowed" } },
    });
    expect(http.status).toBe(201);
  });

  /*
    The three reads that were priced as writes, on their own terms.

    This is a correction to `inferredScopes` that stands whether or not MCP
    exists: `GET /machines` reads the archive's own metadata and was priced with
    registering a machine, and `POST /pack` and
    `POST /distillation/projects/export` store nothing and were priced by their
    verb. A key that may read sessions may read all three; a key that may only
    read may still not register a machine.
  */
  it("lets an archive:read key call the read routes that were priced as writes", async () => {
    const asReader = { token: null, headers: { "x-memoar-key": reader } };
    expect((await api.request("GET", "/machines", asReader)).status).toBe(200);
    // Answered rather than refused; which 2xx each route returns is its own
    // business and not what this asserts.
    expect((await api.request("POST", "/pack", {
      ...asReader,
      body: { query: "archive", maxTokens: 500, maxEvidence: 2, maxSessions: 2, maxExcerptChars: 500, freshnessPolicy: "mixed" },
    })).status).toBeLessThan(300);
    expect((await api.request("POST", "/distillation/projects/export?workspace=/workspace/memoar", asReader)).status).toBeLessThan(300);
    // Registering or reconfiguring a machine is still a machines:write act.
    expect((await api.request("POST", "/machines", { ...asReader, body: { name: "laptop", platform: "macos" } })).status).toBe(403);
    // And a read key still writes nothing to the archive.
    expect((await api.request("POST", "/annotations", {
      ...asReader, body: { sessionId: FIXTURE_SESSION_ID, kind: "note", value: { markdown: "no" } },
    })).status).toBe(403);
  });

  it("mints a token holding what the key holds and nothing beyond it", async () => {
    const tokens = new TokenService();
    for (const [apiKey, expected] of [
      [mcpOnly, ["mcp:use"]],
      [reader, ["mcp:use", "archive:read"]],
      [writer, ["mcp:use", "archive:read", "archive:write"]],
    ] as const) {
      const handshake = await api.request("POST", "/mcp/auth/handshake", {
        token: null, headers: { "x-memoar-key": apiKey }, body: { clientName: "codex", protocolVersion: "2025-06-18" },
      });
      expect(handshake.body.scopes).toEqual([...expected]);
      expect(tokens.verify(str(handshake.body, "accessToken"))!.scopes).toEqual([...expected]);
    }
  });

  it("keeps that token to the MCP endpoint even when it carries archive:read", async () => {
    const handshake = await api.request("POST", "/mcp/auth/handshake", {
      token: null, headers: { "x-memoar-key": writer }, body: { clientName: "codex", protocolVersion: "2025-06-18" },
    });
    const token = str(handshake.body, "accessToken");
    // The grant is for tools, not for the REST API: this token is handed to
    // another program through an environment variable.
    expect((await api.request("GET", "/sessions", { token })).status).toBe(403);
    expect((await api.request("POST", "/annotations", {
      token, body: { sessionId: FIXTURE_SESSION_ID, kind: "note", value: { markdown: "through the token" } },
    })).status).toBe(403);

    const response = await fetch(`${api.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_annotation", arguments: { sessionId: FIXTURE_SESSION_ID, kind: "tag", value: { tag: "by token" } } } }),
    });
    const body = JSON.parse(await response.text()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError, body.result.content[0]!.text).not.toBe(true);
  });
});
