import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arr, str, DEMO_SESSION_ID, startTestApi, type TestApi } from "./helpers/http-app.js";

let api: TestApi;

beforeAll(async () => { api = await startTestApi(); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

describe("authentication", () => {
  it("issues a browser session for valid credentials and refuses everything else", async () => {
    const ok = await api.request("POST", "/auth/login", { token: null, body: { email: "demo@memoar.dev", password: "memoar-demo-password" } });
    expect(ok.status).toBe(200);
    expect(str(ok.body, "accessToken").split(".")).toHaveLength(3);
    expect(ok.body.expiresAt).toBeTruthy();

    expect((await api.request("POST", "/auth/login", { token: null, body: { email: "demo@memoar.dev", password: "" } })).status).toBe(401);
    expect((await api.request("POST", "/auth/login", { token: null, body: { email: "nobody@memoar.dev", password: "memoar-demo-password" } })).status).toBe(401);
  });

  it("rejects tampered, truncated, and foreign-signature bearer tokens", async () => {
    const token = api.token;
    const [header, payload, signature] = token.split(".");
    // A payload edit invalidates the HMAC.
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "attacker", tenantId: "attacker", scopes: ["*"], type: "browser", exp: 9_999_999_999 })).toString("base64url");
    for (const candidate of [
      `${header!}.${forgedPayload}.${signature!}`,
      `${header!}.${payload!}`,
      `${header!}.${payload!}.${signature!}tampered`,
      "not-a-token",
      "",
    ]) {
      const response = await api.request("GET", "/sessions", { token: candidate || null });
      expect(response.status, `token "${candidate.slice(0, 24)}" must not authenticate`).toBe(401);
    }
  });

  it("refuses an expired token", async () => {
    // Mint a token that expired an hour ago using the server's own signing key.
    const { createHmac } = await import("node:crypto");
    const secret = process.env.MEMOAR_TOKEN_SECRET ?? "memoar-development-secret";
    const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const encoded = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      jti: "expired", sub: "u", tenantId: "t", scopes: ["*"], type: "browser",
      exp: Math.floor(Date.now() / 1000) - 3600,
    })}`;
    const expired = `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
    expect((await api.request("GET", "/sessions", { token: expired })).status).toBe(401);
  });
});

describe("api keys", () => {
  it("returns the secret once, authenticates with it, and stops working after revocation", async () => {
    const created = await api.request("POST", "/auth/api-keys", { body: { name: "suite-key", scopes: ["archive:read"] } });
    expect(created.status).toBe(201);
    const secret = str(created.body, "secret");
    const keyId = str(created.body.apiKey as Record<string, string>, "id");

    const listed = await api.request("GET", "/auth/api-keys");
    const stored = arr(listed.body).find((item) => item.id === keyId);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(secret);

    const asKey = await api.request("GET", "/sessions", { token: null, headers: { "x-memoar-key": secret } });
    expect(asKey.status).toBe(200);

    expect((await api.request("DELETE", `/auth/api-keys/${keyId}`)).status).toBe(204);
    expect((await api.request("GET", "/sessions", { token: null, headers: { "x-memoar-key": secret } })).status).toBe(401);
    // Revocation is idempotent for a key that exists; only unknown ids are 404.
    expect((await api.request("DELETE", `/auth/api-keys/${keyId}`)).status).toBe(204);
    expect((await api.request("DELETE", "/auth/api-keys/0191cafe-0000-7000-8000-00000000dead")).status).toBe(404);
  });

  it("holds an api key to the scopes it was granted", async () => {
    const readOnly = await api.request("POST", "/auth/api-keys", { body: { name: "read-only", scopes: ["archive:read"] } });
    const secret = str(readOnly.body, "secret");
    const headers = { "x-memoar-key": secret };

    expect((await api.request("GET", "/sessions", { token: null, headers })).status).toBe(200);
    // Writing needs archive:write, which this key does not hold.
    const write = await api.request("POST", "/annotations", {
      token: null, headers,
      body: { sessionId: DEMO_SESSION_ID, kind: "note", value: { text: "should not persist" } },
    });
    expect(write.status).toBe(403);
  });
});

describe("machine credentials", () => {
  it("confines a machine token to ingest and its own command channel", async () => {
    const machine = await api.request("POST", "/machines", { body: { name: "confinement", platform: "linux" } });
    const machineId = str(machine.body, "id");
    const issued = await api.request("POST", "/auth/machine-token", { body: { machineId } });
    const token = str(issued.body, "token");

    // Archive reads are not part of the machine surface.
    expect((await api.request("GET", "/sessions", { token })).status).toBe(403);
    expect((await api.request("GET", "/settings", { token })).status).toBe(403);

    // Another machine's command channel is refused.
    const other = await api.request("POST", "/machines", { body: { name: "other", platform: "linux" } });
    const otherId = str(other.body, "id");
    const crossChannel = await api.request("POST", `/machines/${otherId}/commands/0191cafe-0000-7000-8000-00000000dead/ack`, { token, body: { status: "completed" } });
    expect(crossChannel.status).toBe(403);

    // Its own channel is allowed through to the handler (404 = no such command).
    const ownChannel = await api.request("POST", `/machines/${machineId}/commands/0191cafe-0000-7000-8000-00000000dead/ack`, { token, body: { status: "completed" } });
    expect(ownChannel.status).toBe(404);
  });

  it("refuses to issue a machine token for a machine outside the tenant", async () => {
    const foreign = await api.request("POST", "/auth/machine-token", { body: { machineId: "0191cafe-0000-7000-8000-00000000dead" } });
    expect(foreign.status).toBe(401);
  });
});

describe("oauth", () => {
  it("refuses unsupported providers and unconfigured ones without leaking a redirect", async () => {
    // No client id is configured in tests, so even a supported provider is refused.
    const unconfigured = await fetch(`${api.baseUrl}/v1/auth/oauth/github`, { redirect: "manual" });
    expect(unconfigured.status).toBe(401);
    const unsupported = await fetch(`${api.baseUrl}/v1/auth/oauth/myspace`, { redirect: "manual" });
    expect(unsupported.status).toBe(401);
  });

  it("refuses a callback whose state was not signed by this server", async () => {
    const callback = await fetch(`${api.baseUrl}/v1/auth/oauth/github/callback?code=abc&state=forged`, { redirect: "manual" });
    expect(callback.status).toBe(401);
  });
});
