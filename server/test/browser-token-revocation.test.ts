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

  it("dies with the key it came from, not with the last key on the account", async () => {
    // The liveness check used to ask whether the *account* still held any
    // unrevoked key. An account with two keys could therefore revoke the one a
    // token was minted from and have that token keep reading whole sessions
    // through get_session and search_sessions until the other key went too.
    const first = await api.request("POST", "/auth/api-keys", { body: { name: "mcp first", scopes: ["mcp:use"] } });
    const second = await api.request("POST", "/auth/api-keys", { body: { name: "mcp second", scopes: ["mcp:use"] } });
    const firstId = str(first.body.apiKey as Record<string, string>, "id");

    const handshake = await api.request("POST", "/mcp/auth/handshake", {
      token: null,
      headers: { "x-memoar-key": str(first.body, "secret") },
      body: { clientName: "codex", protocolVersion: "2025-06-18" },
    });
    const derived = str(handshake.body, "accessToken");
    expect(await mcpStatus(api.baseUrl, derived)).toBe(200);

    expect((await api.request("DELETE", `/auth/api-keys/${firstId}`)).status).toBe(204);

    expect(
      await mcpStatus(api.baseUrl, derived),
      "revoking the key the token came from left it working, because another key was live",
    ).toBe(401);
    // The other key is untouched: revocation is per key in both directions.
    const stillWorking = await api.request("POST", "/mcp/auth/handshake", {
      token: null,
      headers: { "x-memoar-key": str(second.body, "secret") },
      body: { clientName: "codex", protocolVersion: "2025-06-18" },
    });
    expect(stillWorking.status, "revoking one key stopped another key working").toBe(201);
  });

});

describe("an MCP session token carrying more than mcp:use", () => {
  it("is still checked against the key it came from, not against the sign-in", async () => {
    // What kind of token this is used to be inferred from its scope list
    // carrying mcp:use and nothing else. Widen the handshake's grant by one
    // scope under that rule and every token it mints stops being recognised:
    // it would be taken for a sign-in and outlive the key it was made from
    // for the rest of its hour. The type says so now, so the scopes are free
    // to change. Minted here rather than by the handshake because the
    // handshake grants one scope today — the point is that it need not.
    const created = await api.request("POST", "/auth/api-keys", { body: { name: "mcp wide", scopes: ["mcp:use", "archive:read"] } });
    // Without a database the API key *is* its own identity row, so the id the
    // caller gets back is the credential the token names.
    const keyId = str(created.body.apiKey as Record<string, string>, "id");
    const wide = new TokenService().issue({
      sub: api.context.userId,
      tenantId: api.context.tenantId,
      scopes: ["mcp:use", "archive:read"],
      type: "mcp",
      credentialId: keyId,
    }, 3600);

    expect(await mcpStatus(api.baseUrl, wide.token)).toBe(200);

    expect((await api.request("DELETE", `/auth/api-keys/${keyId}`)).status).toBe(204);

    expect(await mcpStatus(api.baseUrl, wide.token), "a wider MCP token outlived its key, read as a sign-in").toBe(401);
    expect((await api.request("GET", "/sessions", { token: wide.token })).status).toBe(401);
  });
});

describe("a handshake token minted before the handshake said so in the token", () => {
  /**
   * The identity the development bearer token stands for. Used here because it
   * holds API keys and no sign-in identity, which is exactly the shape a token
   * minted out of an API key has — and the shape that tells a token honoured
   * for the credential behind it apart from one honoured for its subject.
   */
  const devIdentity = { sub: "0191cafe-0000-7000-8000-000000000002", tenantId: "0191cafe-0000-7000-8000-000000000002" };

  it("keeps working across the deploy, and still dies with the keys behind it", async () => {
    // The old handshake minted `type: "browser"` carrying mcp:use and nothing
    // else. Those tokens are in flight when this ships and have up to an hour
    // left, so the old shape is still read — as it always was, per account.
    const created = await api.request("POST", "/auth/api-keys", {
      token: "memoar-development-token",
      body: { name: "legacy handshake", scopes: ["mcp:use"] },
    });
    const keyId = str(created.body.apiKey as Record<string, string>, "id");
    const legacy = new TokenService().issue({ ...devIdentity, scopes: ["mcp:use"], type: "browser" }, 3600);

    expect(await mcpStatus(api.baseUrl, legacy.token), "a token in flight was dropped by the deploy").toBe(200);

    expect((await api.request("DELETE", `/auth/api-keys/${keyId}`, { token: "memoar-development-token" })).status).toBe(204);

    expect(await mcpStatus(api.baseUrl, legacy.token), "the old shape stopped being checked at all").toBe(401);
  });
});

describe("an MCP session token minted through development auth", () => {
  it("still opens MCP, though there is no key behind it to revoke", async () => {
    // Development auth has no API key, so the token it mints carries no
    // credential to check. It is accepted only because this process opted into
    // development auth by name; a token with no credential on a real
    // deployment resolves to nothing.
    const handshake = await api.request("POST", "/mcp/auth/handshake", {
      token: "memoar-development-token",
      body: { clientName: "codex", protocolVersion: "2025-06-18" },
    });

    expect(handshake.status).toBe(201);
    expect(await mcpStatus(api.baseUrl, str(handshake.body, "accessToken"))).toBe(200);
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
