/**
 * A scrape endpoint for a process that is not a web server.
 *
 * The worker does the slow, failure-prone half of the product — parsing,
 * conversion, the retention sweep — and had no way to say anything about
 * itself. Its logs went to a container, and everything the API reports covers
 * only the API. So it listens on its own port and serves the two operator
 * endpoints: `/metrics`, and `/errors` for the failures grouped in this
 * process — which are the ones that mean a transcript was never archived, and
 * which no request ever sees.
 *
 * Same rule as the API's endpoints: it exists only when a token is configured,
 * and it always requires that token.
 */

import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { errorAggregator } from "../errors/error-aggregator.js";
import { logLine } from "../observability.js";
import { METRICS_CONTENT_TYPE, renderMetrics } from "./metrics.registry.js";

function matches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MetricsListenerOptions {
  /** Required. Without one there is nothing to listen for. */
  token: string | undefined;
  port?: number;
  host?: string;
  /**
   * Produces the exposition text. The worker passes the service's, which reads
   * queue depth first; the default reports what is already held.
   */
  render?: () => Promise<string>;
}

/**
 * Starts the listener, or returns null when it has not been configured.
 *
 * Takes its configuration rather than reading the environment, so that a test
 * can start one without changing a variable the rest of the process is using.
 * Reading `process.env` in here made a test that starts a listener able to
 * break a test that starts an API, intermittently, in whichever order the
 * workers happened to run.
 */
export function startMetricsListener(options: MetricsListenerOptions): Server | null {
  const token = options.token?.trim();
  const port = options.port ?? 9464;
  const render = options.render ?? renderMetrics;
  if (!token) return null;

  const server = createServer((request, response) => {
    void (async () => {
      const supplied = request.headers.authorization?.replace(/^Bearer /u, "");
      const path = request.url?.split("?")[0];
      if (path !== "/metrics" && path !== "/errors") {
        response.writeHead(404).end();
        return;
      }
      if (!supplied || !matches(supplied, token)) {
        response.writeHead(403).end();
        return;
      }
      try {
        // The worker's failures are the ones that mean a transcript was never
        // archived, and they are grouped in this process's memory. Without this
        // they would be counted and never readable.
        if (path === "/errors") {
          response.writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(errorAggregator.snapshot()));
          return;
        }
        response.writeHead(200, { "content-type": METRICS_CONTENT_TYPE }).end(await render());
      } catch (error) {
        // A scrape that fails must not take the worker with it.
        logLine({ level: "error", event: "metrics_scrape_failed", message: error instanceof Error ? error.message : String(error) });
        response.writeHead(500).end();
      }
    })();
  });

  // Every interface, because the scraper is a different container and could
  // not reach loopback. The token is what protects this, not the binding — set
  // MEMOAR_METRICS_HOST to 127.0.0.1 when the scraper shares the host.
  server.listen(port, options.host ?? "0.0.0.0");
  return server;
}
