import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arr, str, TEST_ACCOUNT, FIXTURE_SESSION_ID, startTestApi, type TestApi } from "./helpers/http-app.js";

let api: TestApi;

beforeAll(async () => { api = await startTestApi(); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

describe("authentication", () => {
  it("issues a browser session for valid credentials and refuses everything else", async () => {
    const ok = await api.request("POST", "/auth/login", { token: null, body: { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password } });
    expect(ok.status).toBe(200);
    expect(str(ok.body, "accessToken").split(".")).toHaveLength(3);
    expect(ok.body.expiresAt).toBeTruthy();

    // A well-formed body with the wrong secret is an authentication failure,
    // and must not distinguish a wrong password from an unknown account.
    const wrongPassword = await api.request("POST", "/auth/login", { token: null, body: { email: TEST_ACCOUNT.email, password: "wrong-but-long-enough" } });
    const unknownAccount = await api.request("POST", "/auth/login", { token: null, body: { email: "nobody@memoar.dev", password: TEST_ACCOUNT.password } });
    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    // Each response carries its own request id, so what is compared is what the
    // two answers say: a wrong password and an account that does not exist must
    // be indistinguishable, or the endpoint enumerates accounts.
    const said = (body: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(body).filter(([key]) => key !== "requestId"));
    expect(said(wrongPassword.body)).toEqual(said(unknownAccount.body));
  });

  it("answers malformed login bodies with 400 rather than a 500", async () => {
    // /auth/login is unauthenticated, so anyone could reach it. The body was
    // declared as an inline interface, which the ValidationPipe cannot see, so
    // every one of these reached the service and came back as a 500.
    for (const body of [
      {},
      { email: TEST_ACCOUNT.email },
      { password: TEST_ACCOUNT.password },
      { email: 5, password: [] },
      { email: "not-an-email", password: TEST_ACCOUNT.password },
      { email: TEST_ACCOUNT.email, password: "short" },
      { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password, role: "admin" },
    ]) {
      const response = await api.request("POST", "/auth/login", { token: null, body });
      expect(response.status, `body ${JSON.stringify(body)} should be rejected as malformed`).toBe(400);
    }
  });

  it("validates api key and machine token bodies", async () => {
    for (const body of [{}, { name: "" }, { name: "x" }, { name: "x", scopes: "not-an-array" }, { name: "x", scopes: [] }, { name: "x", scopes: [5] }]) {
      expect((await api.request("POST", "/auth/api-keys", { body })).status, JSON.stringify(body)).toBe(400);
    }
    for (const body of [{}, { machineId: "" }, { machineId: "not-a-uuid" }]) {
      expect((await api.request("POST", "/auth/machine-token", { body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("reports the signed-in identity so the client never has to invent one", async () => {
    const me = await api.request("GET", "/auth/me");
    expect(me.status).toBe(200);
    expect(str(me.body, "email")).toBe(TEST_ACCOUNT.email);
    expect(str(me.body, "displayName").length).toBeGreaterThan(0);
    expect(str(me.body, "id")).toBeTruthy();
    // The identity comes from the token, never from the request.
    expect((await api.request("GET", "/auth/me", { token: null })).status).toBe(401);
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
      body: { sessionId: FIXTURE_SESSION_ID, kind: "note", value: { text: "should not persist" } },
    });
    expect(write.status).toBe(403);
  });

  it("refuses a key asking for a scope this server does not grant", async () => {
    // Scopes were bounded only by count and string length, so `*` was askable —
    // and the guard short-circuits on `*` before it compares anything, which
    // made every @RequireScopes in the codebase opt-out by the caller.
    const wildcard = await api.request("POST", "/auth/api-keys", { body: { name: "everything", scopes: ["*"] } });
    expect(wildcard.status, "a key was minted holding the guard's wildcard").toBe(400);
    expect(str(wildcard.body, "code")).toBe("unknown_scope");

    const invented = await api.request("POST", "/auth/api-keys", { body: { name: "invented", scopes: ["archive:read", "billing:admin"] } });
    expect(invented.status).toBe(400);
    expect(str(invented.body, "detail")).toContain("billing:admin");
  });

  it("does not let a key for one's own archive decide who is in a team", async () => {
    // The guard infers a scope from the path, and /teams matched no branch, so
    // every write there fell through to archive:write — the scope for writing
    // one's own archive. Inviting somebody already carried @RequireScopes
    // ("sharing:write") because it decides who may read the members' archives;
    // removing them and accepting an invitation decide exactly the same thing
    // and were inferred as the weaker scope. A key handed to a capture script
    // could not add a member and could empty the team.
    const team = await api.request("POST", "/teams", { body: { name: "scope-inference" } });
    const teamId = str(team.body, "id");
    const created = await api.request("POST", "/auth/api-keys", { body: { name: "archive-only", scopes: ["archive:read", "archive:write"] } });
    const headers = { "x-memoar-key": str(created.body, "secret") };

    // Refused by the guard, so it never reaches the service: a 404 here would
    // mean the key was allowed in and merely found no invitation waiting.
    const accepted = await api.request("POST", `/teams/invitations/${teamId}/accept`, { token: null, headers });
    expect(accepted.status, "an archive-scoped key was let through to answer an invitation").toBe(403);

    // Left until last because without the guard this one succeeds.
    const removed = await api.request("DELETE", `/teams/${teamId}/members/${api.context.userId}`, { token: null, headers });
    expect(removed.status, "an archive-scoped key removed a team member").toBe(403);
  });

  it("answers a sign-out from a caller who has no session to end", async () => {
    // The handler sliced the Authorization header unconditionally, and a caller
    // authenticated by `x-memoar-key` sends none: signing out with an API key
    // in hand threw a TypeError and answered 500. There is nothing to end, and
    // that is not an error — signing out is idempotent everywhere else.
    const created = await api.request("POST", "/auth/api-keys", { body: { name: "sign-out", scopes: ["archive:read", "archive:write"] } });
    const headers = { "x-memoar-key": str(created.body, "secret") };

    const response = await api.request("POST", "/auth/logout", { token: null, headers });
    expect(response.status, "a 500 here is the header being sliced when it is not there").toBe(204);
    // And the key is untouched: there was no session, so none was ended.
    expect((await api.request("GET", "/sessions", { token: null, headers })).status).toBe(200);
  });

  it("refuses a key that would outrank the person creating it", async () => {
    // A signed-in person holds PASSWORD_SCOPES; materialize:read belongs to a
    // machine credential. Delegation can only narrow.
    const response = await api.request("POST", "/auth/api-keys", { body: { name: "promoted", scopes: ["materialize:read"] } });

    expect(response.status).toBe(403);
    expect(str(response.body, "code")).toBe("scope_escalation");
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

  it("gives the browser its half of the state, and refuses a callback that cannot show it", async () => {
    process.env.GITHUB_CLIENT_ID = "a-client-id";
    process.env.GITHUB_CLIENT_SECRET = "a-client-secret";
    try {
      const begun = await fetch(`${api.baseUrl}/v1/auth/oauth/github`, { redirect: "manual" });
      expect(begun.status).toBe(302);
      const cookie = begun.headers.get("set-cookie") ?? "";
      expect(cookie, "the browser was given nothing to prove it started this").toContain("memoar_oauth_state=");
      expect(cookie).toContain("HttpOnly");
      const state = new URL(begun.headers.get("location")!).searchParams.get("state")!;

      // The state is real — this server minted it a moment ago. What the
      // request does not have is the cookie that came with it, which is exactly
      // the position a victim's browser is in when an attacker feeds it a
      // callback from a sign-in the attacker began. Answering it would sign
      // this browser in to the attacker's archive.
      const forged = await fetch(
        `${api.baseUrl}/v1/auth/oauth/github/callback?code=a-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(forged.status, "a callback with no cookie was let through to exchange the code").toBe(401);
    } finally {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
    }
  });
});
