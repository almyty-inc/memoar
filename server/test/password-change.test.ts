import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApi, str, type TestApi } from "./helpers/http-app.js";

/**
 * Changing a password while signed in.
 *
 * There was no way to do it at all: login, register and methods were the only
 * routes that touched a password. Each test registers its own account, so no
 * test changes a password another one relies on. Passwords are made here, at
 * run time, and never written into a fixture.
 */
let api: TestApi;

beforeAll(async () => { api = await startTestApi({ MEMOAR_SIGNUP: "open" }); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

function freshPassword(): string {
  return `pw-${randomBytes(12).toString("hex")}`;
}

async function freshAccount(): Promise<{ email: string; password: string; token: string }> {
  const email = `change-${randomBytes(6).toString("hex")}@memoar.test`;
  const password = freshPassword();
  const registered = await api.request("POST", "/auth/register", { token: null, body: { email, password } });
  expect(registered.status).toBe(201);
  return { email, password, token: str(registered.body, "accessToken") };
}

async function login(email: string, password: string): Promise<number> {
  return (await api.request("POST", "/auth/login", { token: null, body: { email, password } })).status;
}

async function signIn(email: string, password: string): Promise<string> {
  return str((await api.request("POST", "/auth/login", { token: null, body: { email, password } })).body, "accessToken");
}

async function meStatus(token: string): Promise<number> {
  return (await api.request("GET", "/auth/me", { token })).status;
}

describe("changing a password", () => {
  it("refuses a wrong current password and changes nothing", async () => {
    const account = await freshAccount();
    const other = await signIn(account.email, account.password);

    const refused = await api.request("POST", "/auth/password", {
      token: account.token,
      body: { currentPassword: freshPassword(), newPassword: freshPassword() },
    });

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("wrong_password");
    expect(await login(account.email, account.password), "the old password stopped working after a refusal").toBe(200);
    expect(await meStatus(account.token)).toBe(200);
    expect(await meStatus(other), "a refused change ended another session").toBe(200);
  });

  it("refuses a new password that fails the registration rule", async () => {
    const account = await freshAccount();
    const refused = await api.request("POST", "/auth/password", {
      token: account.token,
      body: { currentPassword: account.password, newPassword: "short" },
    });

    expect(refused.status).toBe(400);
    expect(await login(account.email, account.password)).toBe(200);
  });

  it("retires the old password and accepts the new one", async () => {
    const account = await freshAccount();
    const next = freshPassword();

    const changed = await api.request("POST", "/auth/password", {
      token: account.token,
      body: { currentPassword: account.password, newPassword: next },
    });

    expect(changed.status).toBe(204);
    expect(await login(account.email, account.password), "the old password still signs in").toBe(401);
    expect(await login(account.email, next)).toBe(200);
  });

  it("ends every other session and keeps the caller's", async () => {
    const account = await freshAccount();
    const laptop = await signIn(account.email, account.password);
    const phone = await signIn(account.email, account.password);

    const changed = await api.request("POST", "/auth/password", {
      token: account.token,
      body: { currentPassword: account.password, newPassword: freshPassword() },
    });

    expect(changed.status).toBe(204);
    expect(await meStatus(laptop), "another session outlived the change").toBe(401);
    expect(await meStatus(phone), "another session outlived the change").toBe(401);
    expect(await meStatus(account.token), "the change signed its own caller out").toBe(200);
  });

  it("lets a sign-in made right after the change stay signed in", async () => {
    const account = await freshAccount();
    const next = freshPassword();
    await api.request("POST", "/auth/password", { token: account.token, body: { currentPassword: account.password, newPassword: next } });

    expect(await meStatus(await signIn(account.email, next))).toBe(200);
  });

  it("is made from a browser session, never from an API key", async () => {
    const account = await freshAccount();
    const created = await api.request("POST", "/auth/api-keys", { token: account.token, body: { name: "script", scopes: ["archive:write"] } });
    const secret = str(created.body, "secret");

    const refused = await api.request("POST", "/auth/password", {
      token: null,
      headers: { "x-memoar-key": secret },
      body: { currentPassword: account.password, newPassword: freshPassword() },
    });

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("browser_session_required");
    expect(await login(account.email, account.password)).toBe(200);
  });

  it("tells the client there is a password to change", async () => {
    const account = await freshAccount();
    const me = await api.request("GET", "/auth/me", { token: account.token });
    expect(me.body.hasPassword).toBe(true);
    const signedIn = await api.request("POST", "/auth/login", { token: null, body: { email: account.email, password: account.password } });
    expect((signedIn.body.user as Record<string, unknown>).hasPassword).toBe(true);
  });
});
