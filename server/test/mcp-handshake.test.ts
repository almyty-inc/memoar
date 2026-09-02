import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApi, str, type TestApi } from "./helpers/http-app.js";

let api: TestApi;
let apiKey: string;

beforeAll(async () => {
  api = await startTestApi();
  const created = await api.request("POST", "/auth/api-keys", { body: { name: "mcp handshake", scopes: ["mcp:use", "archive:read"] } });
  apiKey = str(created.body, "secret");
}, 30_000);

afterAll(async () => { if (api) await api.close(); });

describe("the MCP handshake", () => {
  it("exchanges an API key for a token a header-less client can use", async () => {
    // The MCP endpoint authenticates an API key through x-memoar-key, and a
    // client that can only send a bearer token — Codex takes one from an
    // environment variable and nothing else — had no way in. The handshake was
    // documented as minting a token and returned only an endpoint and a list.
    const response = await api.request("POST", "/mcp/auth/handshake", {
      token: null,
      headers: { "x-memoar-key": apiKey },
      body: { clientName: "codex", protocolVersion: "2025-06-18" },
    });

    expect(response.status).toBe(201);
    expect(str(response.body, "endpoint")).toBe("/mcp");
    expect(str(response.body, "accessToken").split(".")).toHaveLength(3);
    expect(response.body.expiresAt).toBeTruthy();
  });

  it("mints a token that opens MCP and nothing else", async () => {
    // A token handed to another program should not also be able to read the
    // archive directly, so it carries mcp:use alone.
    const handshake = await api.request("POST", "/mcp/auth/handshake", {
      token: null,
      headers: { "x-memoar-key": apiKey },
      body: { clientName: "codex", protocolVersion: "2025-06-18" },
    });
    const token = str(handshake.body, "accessToken");

    expect((await api.request("GET", "/sessions", { token })).status, "the archive is not part of the grant").toBe(403);

    // MCP is served outside the /v1 prefix, so this goes to the app root.
    const initialize = await fetch(`${api.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } } }),
    });
    expect(initialize.status, "but MCP is").toBe(200);
  });

  it("refuses a browser session with a reason instead of a 500", async () => {
    // This threw a bare Error, so using the wrong kind of credential — the
    // caller's own mistake, and an easy one — came back as "Internal server
    // error" with nothing to act on.
    const response = await api.request("POST", "/mcp/auth/handshake", {
      body: { clientName: "browser", protocolVersion: "2025-06-18" },
    });

    expect(response.status).toBe(403);
    expect(str(response.body, "code")).toBe("mcp_api_key_required");
    expect(str(response.body, "detail")).toContain("API key");
  });

  it("rejects a malformed body rather than reaching the handler", async () => {
    // The body was an inline interface, which the validation pipe cannot see.
    for (const body of [{}, { clientName: "codex" }, { protocolVersion: "1" }, { clientName: 5, protocolVersion: [] }, { clientName: "c", protocolVersion: "1", extra: true }]) {
      const response = await api.request("POST", "/mcp/auth/handshake", {
        token: null,
        headers: { "x-memoar-key": apiKey },
        body,
      });
      expect(response.status, `accepted ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it("refuses an unauthenticated handshake", async () => {
    const response = await api.request("POST", "/mcp/auth/handshake", {
      token: null,
      body: { clientName: "codex", protocolVersion: "2025-06-18" },
    });
    expect(response.status).toBe(401);
    expect(str(response.body, "code")).toBe("unauthorized");
  });
});
