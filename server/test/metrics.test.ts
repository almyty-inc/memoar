import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registry } from "../src/metrics/metrics.registry.js";
import { startTestApi, type TestApi } from "./helpers/http-app.js";

const TOKEN = "a-metrics-token-nobody-published";

let api: TestApi;

beforeAll(async () => { api = await startTestApi({ MEMOAR_METRICS_TOKEN: TOKEN }); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

/** One sample's value, by metric name and labels, straight from the registry. */
async function sample(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = await registry.getSingleMetricAsString(name);
  const values = (await registry.getMetricsAsJSON()).find((entry) => entry.name === name);
  expect(values, `${name} is not registered:\n${metric}`).toBeDefined();
  const found = (values as { values: { labels: Record<string, string>; value: number }[] }).values
    .find((entry) => Object.entries(labels).every(([key, value]) => entry.labels[key] === value));
  return found?.value ?? 0;
}

describe("what the service says about itself", () => {
  it("refuses a scrape without the token", async () => {
    // The numbers say how much is being archived and how big this deployment
    // is, and a scrape endpoint is reachable by anyone who can reach the
    // service.
    expect((await api.request("GET", "/metrics", { token: null })).status).toBe(403);
    expect((await api.request("GET", "/metrics", { token: "not-the-token" })).status).toBe(403);
  });

  it("serves the exposition format to a scraper that has it", async () => {
    const response = await fetch(`${api.baseUrl}/v1/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");

    const body = await response.text();
    expect(body).toContain("# HELP memoar_http_requests_total");
    expect(body).toContain("# TYPE memoar_http_request_duration_seconds histogram");
    // Event-loop lag is the one that explains "everything is slow at once".
    expect(body).toContain("memoar_nodejs_eventloop_lag_seconds");
  });

  it("counts requests by route pattern, not by path", async () => {
    // A metric labelled with the concrete path is one time series per session:
    // an unbounded label set, and the usual way a metrics store is brought down
    // by the service it watches.
    await api.request("GET", "/sessions");
    const before = await sample("memoar_http_requests_total", { route: "/v1/sessions", status: "200" });
    await api.request("GET", "/sessions");
    await api.request("GET", "/sessions");

    expect(await sample("memoar_http_requests_total", { route: "/v1/sessions", status: "200" })).toBe(before + 2);

    const body = await (await fetch(`${api.baseUrl}/v1/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    const sessionId = "0191cafe-0000-7000-8000-00000000d001";
    expect(body, "a concrete id must never appear in a label").not.toContain(sessionId);
  });

  it("records a failed request against the status it failed with", async () => {
    const before = await sample("memoar_http_requests_total", { route: "/v1/sessions/:sessionId", status: "404" });
    await api.request("GET", "/sessions/0191cafe-0000-7000-8000-0000000000ff");

    // The error path has to record too: a request that fails is the one worth
    // counting, and the response has not been written when the filter runs.
    expect(await sample("memoar_http_requests_total", { route: "/v1/sessions/:sessionId", status: "404" })).toBe(before + 1);
  });

  it("counts rejected credentials by why they were rejected", async () => {
    const before = await sample("memoar_auth_failures_total", { reason: "unauthenticated" });
    await api.request("GET", "/sessions", { token: "not-a-real-token" });

    expect(await sample("memoar_auth_failures_total", { reason: "unauthenticated" })).toBe(before + 1);
  });

  it("counts archived sessions by the tool they came from, and never by tenant", async () => {
    const body = await (await fetch(`${api.baseUrl}/v1/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    // A tenant label grows a series per customer and puts who-uses-what into a
    // system that is scraped and stored more freely than the archive is.
    expect(body).not.toContain("tenant");
    expect(body).not.toContain(api.context.tenantId);
  });
});

describe("when no token is configured", () => {
  let unconfigured: TestApi;
  beforeAll(async () => { unconfigured = await startTestApi({ MEMOAR_METRICS_TOKEN: "" }); }, 30_000);
  afterAll(async () => { if (unconfigured) await unconfigured.close(); });

  it("does not answer at all", async () => {
    // Not 403: an endpoint that answers differently when unconfigured tells a
    // stranger it is there and waiting for a secret.
    expect((await unconfigured.request("GET", "/metrics", { token: null })).status).toBe(404);
  });
});
