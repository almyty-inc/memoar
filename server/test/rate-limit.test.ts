import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryRateLimitStore } from "../src/rate-limit.js";
import { TEST_ACCOUNT, startTestApi, type TestApi } from "./helpers/http-app.js";

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
    const known = await guess(TEST_ACCOUNT.email);
    expect(unknown.status).toBe(known.status);
    // Every response carries its own request id, so the comparison is of what
    // the two answers say — which must be nothing that distinguishes them.
    const said = (body: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(body).filter(([key]) => key !== "requestId"));
    expect(said(unknown.body)).toEqual(said(known.body));
    expect(unknown.body.requestId, "and each is traceable on its own").not.toBe(known.body.requestId);
  });

  it("does not spend the budget on sign-ins that succeed", async () => {
    // Counting every attempt locks out the person who signs in repeatedly for
    // legitimate reasons — a browser suite, a shared office address — while
    // barely inconveniencing an attacker, who needs only one success.
    for (let index = 0; index < 8; index += 1) {
      const response = await api.request("POST", "/auth/login", {
        token: null,
        body: { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password },
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

  it("cannot be escaped by claiming a different address", async () => {
    // X-Forwarded-For is written by whoever sends the request. Reading it
    // without being told a proxy is in front of the process handed every caller
    // a free choice of identity: a new address per attempt bought a new budget
    // per attempt, and ten thousand guesses cost nothing.
    const email = "target-four@memoar.dev";
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await api.request("POST", "/auth/login", {
        token: null,
        headers: { "x-forwarded-for": `10.0.0.${index}` },
        body: { email, password: "wrong-but-long-enough" },
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(3), "the claimed address bought no extra budget").toEqual([429, 429]);
  });

  it("leaves an authenticated read alone: it draws on the ordinary budget", async () => {
    expect((await api.request("GET", "/sessions?limit=1")).status).toBe(200);
  });
});

describe("a guessing budget spent from many addresses at once", () => {
  /**
   * The distributed case, which is the one this limit is for.
   *
   * The failure key used to include the caller's address, so the budget was
   * partitioned per source: three guesses per address against one account meant
   * a thousand addresses bought three thousand guesses, and a botnet paid
   * nothing at all. The comment above the key said the opposite.
   *
   * Its own server, told to trust one proxy hop, because that is the only way a
   * test can present itself as arriving from different addresses.
   */
  let proxied: TestApi;

  beforeAll(async () => {
    proxied = await startTestApi({ MEMOAR_TRUSTED_PROXY_HOPS: "1" });
  }, 30_000);

  afterAll(async () => {
    delete process.env.MEMOAR_TRUSTED_PROXY_HOPS;
    if (proxied) await proxied.close();
  });

  it("belongs to the account being guessed at, not to each address guessing", async () => {
    const email = "target-five@memoar.dev";
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await proxied.request("POST", "/auth/login", {
        token: null,
        headers: { "x-forwarded-for": `203.0.113.${index}` },
        body: { email, password: "wrong-but-long-enough" },
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(3), "a new source address bought a fresh budget").toEqual([429, 429]);
  });

  it("still leaves a different account alone", async () => {
    // Per-account, not per-server: one person under attack must not lock out
    // everybody else on the archive.
    const response = await proxied.request("POST", "/auth/login", {
      token: null,
      headers: { "x-forwarded-for": "203.0.113.9" },
      body: { email: "bystander-five@memoar.dev", password: "wrong-but-long-enough" },
    });

    expect(response.status).toBe(401);
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
