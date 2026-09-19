import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service.js";
import { TokenService } from "../src/auth/tokens.js";
import { BrowserSessionService } from "../src/auth/browser-sessions.js";
import { CredentialsService } from "../src/auth/credentials.service.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";

/**
 * Signing in with a provider.
 *
 * This is the path that creates an account out of a redirect, so the checks in
 * it are the only thing between a crafted callback and somebody else's archive.
 * It was the least covered code in the service.
 */
const environment = { ...process.env };

function service(): AuthService {
  const tokens = new TokenService();
  const store = new DevArchiveStore();
  return new AuthService(tokens, null, store, new BrowserSessionService(null), new CredentialsService(tokens, null, store));
}

beforeEach(() => {
  process.env.GITHUB_CLIENT_ID = "github-client";
  process.env.GITHUB_CLIENT_SECRET = "github-secret";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  process.env.MEMOAR_PUBLIC_URL = "https://api.memoar.test";
  process.env.MEMOAR_SIGNUP = "open";
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...environment };
});

describe("starting a provider sign-in", () => {
  it("sends the caller to the provider with a state it can check later", () => {
    const url = new URL(service().beginOAuth("github"));

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("github-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.memoar.test/v1/auth/oauth/github/callback");
    // The state is what stops a callback from an unrelated page being accepted
    // as the end of a sign-in nobody here started.
    expect(url.searchParams.get("state")?.length).toBeGreaterThan(10);
  });

  it("asks Google for the scopes Google needs, and says it wants a code", () => {
    const url = new URL(service().beginOAuth("google"));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("refuses a provider it does not have credentials for", () => {
    delete process.env.GITHUB_CLIENT_ID;
    expect(() => service().beginOAuth("github")).toThrow(/not configured/u);
  });

  it("refuses a provider it has never heard of", () => {
    expect(() => service().beginOAuth("some-other-idp")).toThrow(/Unsupported OAuth provider/u);
  });
});

describe("finishing a provider sign-in", () => {
  it("refuses a callback whose state it did not issue", async () => {
    // Without this, anybody who can make the browser hit the callback can begin
    // a sign-in the archive never started.
    await expect(service().completeOAuth("github", "a-code", "a-state-nobody-issued"))
      .rejects.toThrow(/Invalid OAuth state/u);
  });

  it("refuses a state issued for a different provider", async () => {
    const auth = service();
    const githubState = new URL(auth.beginOAuth("github")).searchParams.get("state")!;

    await expect(auth.completeOAuth("google", "a-code", githubState))
      .rejects.toThrow(/Invalid OAuth state/u);
  });

  it("refuses when the provider will not exchange the code", async () => {
    const auth = service();
    const state = new URL(auth.beginOAuth("github")).searchParams.get("state")!;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({}) }));

    await expect(auth.completeOAuth("github", "a-code", state)).rejects.toThrow(/token exchange failed/u);
  });

  it("refuses when the provider hands back no token", async () => {
    const auth = service();
    const state = new URL(auth.beginOAuth("github")).searchParams.get("state")!;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));

    await expect(auth.completeOAuth("github", "a-code", state)).rejects.toThrow(/no access token/u);
  });

  /** The tenant a returned redirect actually signed the browser in to. */
  function tenantOf(redirect: string): string {
    const token = new URLSearchParams(new URL(redirect).hash.slice(1)).get("access_token")!;
    return (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { tenantId: string }).tenantId;
  }

  function providerReplies(email: string, name = "A Person"): void {
    const responses = [
      { ok: true, json: () => Promise.resolve({ access_token: "provider-token" }) },
      { ok: true, json: () => Promise.resolve({ email, name }) },
    ];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(responses.shift())));
  }

  it("refuses a stranger when this archive is closed to new accounts", async () => {
    // A closed archive that merely has GITHUB_CLIENT_ID set used to hand anyone
    // with a GitHub account a fully scoped session, while /auth/register
    // refused the same person by name.
    delete process.env.MEMOAR_SIGNUP;
    const auth = service();
    const state = new URL(auth.beginOAuth("github")).searchParams.get("state")!;
    providerReplies("stranger@memoar.test");

    await expect(auth.completeOAuth("github", "a-code", state))
      .rejects.toMatchObject({ response: { code: "registration_closed" } });
  });

  it("puts one address in one tenant however they signed in", async () => {
    // The tenant used to be the user id rather than the tenant on the identity,
    // so signing in the second way opened a second, empty archive.
    const auth = service();
    const registered = await auth.register("both-ways@memoar.test", "a-password-long-enough");
    const passwordTenant = (JSON.parse(
      Buffer.from(registered.accessToken.split(".")[1]!, "base64url").toString("utf8"),
    ) as { tenantId: string }).tenantId;

    const state = new URL(auth.beginOAuth("github")).searchParams.get("state")!;
    providerReplies("both-ways@memoar.test");

    expect(tenantOf(await auth.completeOAuth("github", "a-code", state))).toBe(passwordTenant);
  });

  it("keeps two different people in two different tenants", async () => {
    const auth = service();
    const first = new URL(auth.beginOAuth("github")).searchParams.get("state")!;
    providerReplies("one@memoar.test");
    const oneTenant = tenantOf(await auth.completeOAuth("github", "a-code", first));

    const second = new URL(auth.beginOAuth("github")).searchParams.get("state")!;
    providerReplies("two@memoar.test");
    const twoTenant = tenantOf(await auth.completeOAuth("github", "a-code", second));

    expect(oneTenant).not.toBe(twoTenant);
  });

  it("signs in the account the provider vouched for", async () => {
    const auth = service();
    const state = new URL(auth.beginOAuth("github")).searchParams.get("state")!;
    const responses = [
      { ok: true, json: () => Promise.resolve({ access_token: "provider-token" }) },
      { ok: true, json: () => Promise.resolve({ email: "person@memoar.test", name: "A Person" }) },
    ];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(responses.shift())));

    const redirect = await auth.completeOAuth("github", "a-code", state);

    // The redirect carries the session, so the browser lands signed in rather
    // than back on the form it just came from.
    expect(redirect).toContain("token=");
    expect(redirect).not.toContain("provider-token");
  });

  it("refuses when the provider will not say who this is", async () => {
    const auth = service();
    const state = new URL(auth.beginOAuth("google")).searchParams.get("state")!;
    const responses = [
      { ok: true, json: () => Promise.resolve({ access_token: "provider-token" }) },
      { ok: false, status: 403, json: () => Promise.resolve({}) },
    ];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(responses.shift())));

    await expect(auth.completeOAuth("google", "a-code", state)).rejects.toThrow(/profile lookup failed/u);
  });
});
