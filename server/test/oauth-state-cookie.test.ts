import { afterEach, describe, expect, it } from "vitest";
import { clearedOAuthStateCookie, oauthStateCookie, oauthStateNonce } from "../src/auth/oauth-state-cookie.js";

/**
 * The cookie is the only half of the OAuth state that stays with the browser,
 * so its attributes are the binding. Get them wrong and the check still passes
 * in every test while doing nothing in a real browser: Strict withholds the
 * cookie on the redirect back from the provider, a missing Path scatters it
 * across the API, and a missing HttpOnly puts it where a script can read it.
 */
const environment = { ...process.env };

afterEach(() => { process.env = { ...environment }; });

describe("the cookie that binds a sign-in to a browser", () => {
  it("is sent on the redirect back from the provider and nowhere else", () => {
    const cookie = oauthStateCookie("a-nonce");

    expect(cookie).toContain("memoar_oauth_state=a-nonce");
    // Lax, not Strict: the callback is a top-level navigation from the
    // provider's domain, and Strict withholds the cookie on exactly that
    // request — leaving every real sign-in failing its own state check.
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/v1/auth/oauth");
    expect(cookie).toContain("HttpOnly");
    // Ten minutes, the life of the state it is bound to.
    expect(cookie).toContain("Max-Age=600");
  });

  it("is marked Secure where the archive is served over https", () => {
    expect(oauthStateCookie("a-nonce")).not.toContain("Secure");
    process.env.NODE_ENV = "production";
    expect(oauthStateCookie("a-nonce")).toContain("Secure");
  });

  it("is cleared with the same attributes, or the browser keeps the old one", () => {
    const cleared = clearedOAuthStateCookie();

    expect(cleared).toContain("Max-Age=0");
    // A clear that does not match on path clears nothing, and a state that is
    // never cleared is a state that can be replayed for its whole ten minutes.
    expect(cleared).toContain("Path=/v1/auth/oauth");
  });

  it("finds its nonce among whatever else the browser is carrying", () => {
    expect(oauthStateNonce("memoar_oauth_state=abc")).toBe("abc");
    expect(oauthStateNonce("other=1; memoar_oauth_state=abc; another=2")).toBe("abc");
    // Not a prefix match: a cookie whose name merely ends in ours is not ours.
    expect(oauthStateNonce("not_memoar_oauth_state=abc")).toBeNull();
    expect(oauthStateNonce("memoar_oauth_state=")).toBeNull();
    expect(oauthStateNonce(undefined)).toBeNull();
    expect(oauthStateNonce("nonsense")).toBeNull();
  });
});
