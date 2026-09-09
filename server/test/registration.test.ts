import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { obj, str, startTestApi, type TestApi } from "./helpers/http-app.js";

/**
 * Until now nobody could create an account. The page offered "Continue with
 * GitHub" and "Continue with Google", which fail with 401 on a deployment that
 * has no OAuth credentials, and there was no email registration at all — so the
 * only account that could exist was the one the server makes from
 * MEMOAR_BOOTSTRAP_EMAIL, while the page promised that continuing with a
 * provider would create an archive.
 */
describe("creating an account", () => {
  let api: TestApi;
  beforeAll(async () => { api = await startTestApi({ MEMOAR_SIGNUP: "open" }); }, 30_000);
  afterAll(async () => { if (api) await api.close(); });

  it("signs the new account straight in", async () => {
    const created = await api.request("POST", "/auth/register", {
      token: null,
      body: { email: "newcomer@memoar.test", password: "a-password-of-real-length" },
    });

    expect(created.status).toBe(201);
    expect(str(created.body, "accessToken").length).toBeGreaterThan(20);
    expect(str(obj(created.body, "user"), "email")).toBe("newcomer@memoar.test");
    // Registering and then being told to sign in separately is a form asking to
    // be filled in twice.
    const sessions = await api.request("GET", "/sessions", { token: str(created.body, "accessToken") });
    expect(sessions.status).toBe(200);
  });

  it("gives the new account its own archive", async () => {
    // One tenant per account. Joining somebody else's archive is what sharing
    // and teams are for; it must never be what signing up does.
    const created = await api.request("POST", "/auth/register", {
      token: null,
      body: { email: "separate@memoar.test", password: "a-password-of-real-length" },
    });
    const theirs = await api.request("GET", "/sessions", { token: str(created.body, "accessToken") });

    expect(theirs.status).toBe(200);
    expect(theirs.body.total, "a new account must not see the fixture account's sessions").toBe(0);
    // And the account that was already there still sees its own.
    expect((await api.request("GET", "/sessions")).body.total).toBe(1);
  });

  it("refuses an address that already has an account", async () => {
    const body = { email: "twice@memoar.test", password: "a-password-of-real-length" };
    expect((await api.request("POST", "/auth/register", { token: null, body })).status).toBe(201);

    const again = await api.request("POST", "/auth/register", { token: null, body });
    expect(again.status).toBe(409);
    expect(str(again.body, "code")).toBe("account_exists");
  });

  it("validates the body rather than failing inside the service", async () => {
    const cases = [
      { email: "not-an-address", password: "a-password-of-real-length" },
      { email: "short@memoar.test", password: "short" },
      { email: "extra@memoar.test", password: "a-password-of-real-length", role: "admin" },
      { password: "a-password-of-real-length" },
    ];
    for (const body of cases) {
      expect((await api.request("POST", "/auth/register", { token: null, body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("reports what this deployment accepts", async () => {
    const methods = await api.request("GET", "/auth/methods", { token: null });

    expect(methods.status).toBe(200);
    expect(methods.body.signup).toBe("open");
    expect(methods.body.password).toBe(true);
    // No OAuth credentials here, so no providers are offered. A button for a
    // provider the server cannot talk to fails when somebody presses it.
    expect(methods.body.oauth).toEqual([]);
  });
});

describe("an archive that is not taking new accounts", () => {
  let api: TestApi;
  // The default. An archive holds other people's source code, so a deployment
  // must say strangers may join rather than allowing it by omission.
  beforeAll(async () => { api = await startTestApi({ MEMOAR_SIGNUP: "" }); }, 30_000);
  afterAll(async () => { if (api) await api.close(); });

  it("refuses to create one", async () => {
    const refused = await api.request("POST", "/auth/register", {
      token: null,
      body: { email: "uninvited@memoar.test", password: "a-password-of-real-length" },
    });

    expect(refused.status).toBe(403);
    expect(str(refused.body, "code")).toBe("registration_closed");
  });

  it("says so, so the client does not offer a form that cannot work", async () => {
    expect((await api.request("GET", "/auth/methods", { token: null })).body.signup).toBe("closed");
  });
});
