import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../src/auth/tokens.js";
import { startTestApi, str, TEST_ACCOUNT, type TestApi } from "./helpers/http-app.js";

/**
 * Browser tokens, which were trusted on their signature alone.
 *
 * `authenticateBearer` returned the context before any lookup, so a machine
 * token was re-checked against `auth_identities` on every request while the
 * credential a person actually holds was checked on none: there was no sign-out
 * at all, and a token lifted from a laptop worked for its full hour whatever
 * anyone did about it.
 *
 * One server for the file: every credential these revoke is one they minted
 * themselves, so nothing here takes another test's session with it.
 */
let api: TestApi;

beforeAll(async () => { api = await startTestApi(); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

/** A fresh sign-in, so revoking it says nothing about the suite's own token. */
async function signIn(): Promise<{ token: string }> {
  const login = await api.request("POST", "/auth/login", {
    token: null,
    body: { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password },
  });
  return { token: str(login.body, "accessToken") };
}

describe("signing out", () => {
  it("stops the token working, rather than only clearing the client", async () => {
    const { token } = await signIn();
    expect((await api.request("GET", "/auth/me", { token })).status).toBe(200);

    expect((await api.request("POST", "/auth/logout", { token })).status).toBe(204);

    const after = await api.request("GET", "/auth/me", { token });
    expect(after.status, "the signed-out token is still accepted").toBe(401);
  });

  it("ends one session and leaves the others alone", async () => {
    const { token } = await signIn();
    const second = str((await api.request("POST", "/auth/login", {
      token: null,
      body: { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password },
    })).body, "accessToken");

    await api.request("POST", "/auth/logout", { token });

    expect((await api.request("GET", "/auth/me", { token })).status).toBe(401);
    expect((await api.request("GET", "/auth/me", { token: second })).status, "signing out of one browser closed another").toBe(200);
  });
});

describe("an MCP session token derived from an API key", () => {
  it("dies when the key it was exchanged for is revoked", async () => {
    // The handshake mints a browser-type token out of an API key. Revoking the
    // key used to leave that token — which opens MCP, and MCP reads whole
    // sessions — alive and unrevocable for the rest of its hour.
    const created = await api.request("POST", "/auth/api-keys", { body: { name: "mcp", scopes: ["mcp:use"] } });
    const secret = str(created.body, "secret");
    const keyId = str(created.body.apiKey as Record<string, string>, "id");

    const handshake = await api.request("POST", "/mcp/auth/handshake", {
      token: null,
      headers: { "x-memoar-key": secret },
      body: { clientName: "codex", protocolVersion: "2025-06-18" },
    });
    const derived = str(handshake.body, "accessToken");
    expect(await mcpStatus(api.baseUrl, derived)).toBe(200);

    expect((await api.request("DELETE", `/auth/api-keys/${keyId}`)).status).toBe(204);

    expect(await mcpStatus(api.baseUrl, derived), "the derived token outlived the key").toBe(401);
  });
});

describe("a signed token naming a tenant it was not issued for", () => {
  it("resolves to nothing, because the account is re-read rather than believed", async () => {
    // The tenant is the only thing standing between two archives. A browser
    // token used to be taken entirely at its word about which one it belonged
    // to; now the account behind it has to agree.
    const forged = new TokenService().issue({
      sub: "0191cafe-0000-7000-8000-0000000000a1",
      tenantId: "0191cafe-0000-7000-8000-0000000000a2",
      scopes: ["archive:read", "archive:write"],
      type: "browser",
    }, 3600);

    const response = await api.request("GET", "/sessions", { token: forged.token });

    expect(response.status, "a token for an account this archive has never seen was accepted").toBe(401);
  });
});

/** MCP is served outside the /v1 prefix, so this goes to the app root. */
async function mcpStatus(baseUrl: string, token: string): Promise<number> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } },
    }),
  });
  return response.status;
}
