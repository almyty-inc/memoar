import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryRateLimitStore } from "../src/rate-limit.js";
import { startTestApi, type TestApi } from "./helpers/http-app.js";

let api: TestApi;

beforeAll(async () => {
  // Small enough to reach in a test, which is the only way to prove the limit
  // exists rather than that the code compiles.
  process.env.MEMOAR_CREDENTIAL_RATE_LIMIT = "3/60";
  process.env.MEMOAR_RATE_LIMIT = "100000/60";
  api = await startTestApi();
}, 30_000);

afterAll(async () => {
  delete process.env.MEMOAR_CREDENTIAL_RATE_LIMIT;
  if (api) await api.close();
});

describe("credential endpoints are rate limited", () => {
  /** A distinct account per test, so one test cannot spend another's budget. */
  const guess = (email: string) => api.request("POST", "/auth/login", {
    token: null,
    body: { email, password: "wrong-but-long-enough" },
  });

  it("stops answering guesses against an account once the budget is spent", async () => {
    // Without this, the only thing between an attacker and every password they
    // care to try is how fast the server can reply.
    const email = "target-one@memoar.dev";
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) statuses.push((await guess(email)).status);

    expect(statuses.slice(0, 3), "the budget is three failures").toEqual([401, 401, 401]);
    expect(statuses.slice(3), "everything after is refused").toEqual([429, 429]);
  });

  it("says how long to wait, so a caller can back off rather than hammer", async () => {
    const email = "target-two@memoar.dev";
    for (let index = 0; index < 3; index += 1) await guess(email);
    const response = await guess(email);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("ratelimit-limit"), "the refusing budget is reported").toBe("3");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
  });

  it("treats an account that does not exist exactly like one that does", async () => {
    // Differing here would turn the limiter into the account-enumeration oracle
    // the uniform 401 is meant to avoid.
    const unknown = await guess("nobody-here@memoar.dev");
    const known = await guess("demo@memoar.dev");
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it("does not spend the budget on sign-ins that succeed", async () => {
    // Counting every attempt locks out the person who signs in repeatedly for
    // legitimate reasons — a browser suite, a shared office address — while
    // barely inconveniencing an attacker, who needs only one success.
    for (let index = 0; index < 8; index += 1) {
      const response = await api.request("POST", "/auth/login", {
        token: null,
        body: { email: "demo@memoar.dev", password: "memoar-demo-password" },
      });
      expect(response.status, `sign-in ${index + 1} of 8 was refused`).toBe(200);
    }
  });

  it("counts failures against the account attempted, not the whole address", async () => {
    // One person mistyping a password must not lock out everyone behind the
    // same address.
    const attacked = "target-three@memoar.dev";
    for (let index = 0; index < 4; index += 1) await guess(attacked);
    expect((await guess(attacked)).status, "the attacked account is protected").toBe(429);
    expect((await guess("bystander@memoar.dev")).status, "a different account is unaffected").toBe(401);
  });

  it("leaves an authenticated read alone: it draws on the ordinary budget", async () => {
    expect((await api.request("GET", "/sessions?limit=1")).status).toBe(200);
  });
});

describe("MemoryRateLimitStore", () => {
  it("counts within a window and starts again once it passes", async () => {
    const store = new MemoryRateLimitStore();
    expect(await store.hit("a", 60)).toBe(1);
    expect(await store.hit("a", 60)).toBe(2);
    // A different caller has its own count.
    expect(await store.hit("b", 60)).toBe(1);
    // A window of zero seconds has already elapsed by the next call.
    expect(await store.hit("c", 0)).toBe(1);
    expect(await store.hit("c", 0)).toBe(1);
  });

  it("does not grow without bound as callers come and go", async () => {
    const store = new MemoryRateLimitStore();
    for (let index = 0; index < 10_100; index += 1) await store.hit(`caller-${index}`, 0);
    // Expired windows are swept, so a long-running process does not keep one
    // entry per caller for its whole life.
    expect(await store.hit("caller-0", 60)).toBe(1);
  });
});
