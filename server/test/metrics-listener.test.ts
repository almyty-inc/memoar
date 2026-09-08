import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { errorAggregator } from "../src/errors/error-aggregator.js";
import { startMetricsListener } from "../src/metrics/metrics-listener.js";

const TOKEN = "a-worker-token-nobody-published";
let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
  errorAggregator.reset();
});

/**
 * Configuration is passed, never set in the environment.
 *
 * Vitest's workers are threads and share one process, so a test that set
 * MEMOAR_METRICS_TOKEN here could take it out from under an API another file
 * had already started — which it did, intermittently, once.
 */
function listen(port: number, token: string | undefined = TOKEN): string {
  server = startMetricsListener({ token, port, host: "127.0.0.1" });
  return `http://127.0.0.1:${port}`;
}

/**
 * The worker is not a web server, so everything the API exposes about itself
 * has to be served here separately — and the failures grouped in this process
 * are the ones that mean a transcript was never archived. They belong to no
 * request, so nothing else would ever show them.
 */
describe("what the worker exposes about itself", () => {
  it("does not listen at all without a token", () => {
    expect(startMetricsListener({ token: "" })).toBeNull();
    expect(startMetricsListener({ token: undefined })).toBeNull();
  });

  it("serves metrics and the grouped errors, and refuses both without the token", async () => {
    const base = listen(59481);
    errorAggregator.record(new Error("artifact_not_found"), { route: "job:parse" });

    expect((await fetch(`${base}/errors`)).status, "no credentials").toBe(403);
    expect((await fetch(`${base}/metrics`, { headers: { authorization: "Bearer wrong" } })).status).toBe(403);
    expect((await fetch(`${base}/anything-else`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);

    const errors = await (await fetch(`${base}/errors`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
      groups: { shape: string; lastRoute?: string }[];
    };
    expect(errors.groups[0]!.shape).toBe("artifact_not_found");
    expect(errors.groups[0]!.lastRoute, "a job, not a request").toBe("job:parse");

    const metrics = await (await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    expect(metrics).toContain("memoar_jobs_total");
  });
});
