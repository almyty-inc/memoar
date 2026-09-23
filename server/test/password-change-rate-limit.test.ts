import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApi, str, type TestApi } from "./helpers/http-app.js";

/**
 * A password change answers "is this the password?" to anybody holding a
 * session, stolen ones included, so wrong guesses draw on the credential budget
 * the way sign-in does. The budget belongs to the account being guessed at.
 *
 * Its own file because the budget is set per process: three failures here, a
 * hundred thousand in every other suite.
 */
let api: TestApi;

beforeAll(async () => {
  process.env.MEMOAR_CREDENTIAL_RATE_LIMIT = "3/300";
  api = await startTestApi({ MEMOAR_SIGNUP: "open" });
}, 30_000);
afterAll(async () => { if (api) await api.close(); });

function freshPassword(): string {
  return `pw-${randomBytes(12).toString("hex")}`;
}

async function freshAccount(): Promise<{ password: string; token: string }> {
  const password = freshPassword();
  const registered = await api.request("POST", "/auth/register", {
    token: null, body: { email: `limit-${randomBytes(6).toString("hex")}@memoar.test`, password },
  });
  return { password, token: str(registered.body, "accessToken") };
}

describe("guessing the current password", () => {
  it("is refused once the account's credential budget is spent", async () => {
    const account = await freshAccount();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const wrong = await api.request("POST", "/auth/password", {
        token: account.token, body: { currentPassword: freshPassword(), newPassword: freshPassword() },
      });
      expect(wrong.status).toBe(403);
    }

    const blocked = await api.request("POST", "/auth/password", {
      token: account.token, body: { currentPassword: account.password, newPassword: freshPassword() },
    });
    expect(blocked.status, "a fourth guess was answered").toBe(429);
  });

  it("does not spend anybody else's budget", async () => {
    // The route names no account in its body, so the failures used to be
    // counted under one key shared by every caller.
    const guesser = await freshAccount();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await api.request("POST", "/auth/password", {
        token: guesser.token, body: { currentPassword: freshPassword(), newPassword: freshPassword() },
      });
    }

    const bystander = await freshAccount();
    const changed = await api.request("POST", "/auth/password", {
      token: bystander.token, body: { currentPassword: bystander.password, newPassword: freshPassword() },
    });
    expect(changed.status, "one account's guesses locked another out").toBe(204);
  });
});
