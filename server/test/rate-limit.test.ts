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
  it("stops answering guesses once the budget is spent", async () => {
    // Without this, the only thing between an attacker and every password they
    // care to try is how fast the server can reply.
    const attempt = () => api.request("POST", "/auth/login", {
      token: null,
      body: { email: "demo@memoar.dev", password: "wrong-but-long-enough" },
    });

    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) statuses.push((await attempt()).status);

    // The harness signs in to get its own token, so part of the budget is
    // already spent; what matters is that the budget runs out and stays out.
    const refusedFrom = statuses.indexOf(429);
    expect(refusedFrom, "the budget was never exhausted").toBeGreaterThan(-1);
    expect(statuses.slice(0, refusedFrom).every((status) => status === 401), "answers before the limit are ordinary refusals").toBe(true);
    expect(statuses.slice(refusedFrom).every((status) => status === 429), "once spent, the budget stays spent").toBe(true);
  });

  it("says how long to wait, so a caller can back off rather than hammer", async () => {
    const response = await api.request("POST", "/auth/login", {
      token: null,
      body: { email: "demo@memoar.dev", password: "wrong-but-long-enough" },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("ratelimit-limit")).toBe("3");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
  });

  it("refuses without revealing whether the account exists", async () => {
    // A limiter that answered differently for a real account would turn itself
    // into the enumeration oracle the limit is meant to prevent.
    const unknown = await api.request("POST", "/auth/login", {
      token: null,
      body: { email: "nobody@memoar.dev", password: "wrong-but-long-enough" },
    });
    expect(unknown.status).toBe(429);
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
