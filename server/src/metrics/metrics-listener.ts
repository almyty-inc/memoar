/**
 * A scrape endpoint for a process that is not a web server.
 *
 * The worker does the slow, failure-prone half of the product — parsing,
 * conversion, the retention sweep — and had no way to say anything about
 * itself. Its logs went to a container, and everything the API reports covers
 * only the API. So it listens on its own port, for metrics and nothing else.
 *
 * Same rule as the API's endpoint: it exists only when a token is configured,
 * and it always requires that token.
 */

import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { logLine } from "../observability.js";
import { METRICS_CONTENT_TYPE, renderMetrics } from "./metrics.registry.js";

function matches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Starts the listener, or returns null when it has not been configured.
 *
 * @param render produces the exposition text. The worker passes the service's,
 *   which reads queue depth first; the default reports what is already held.
 */
export function startMetricsListener(render: () => Promise<string> = renderMetrics): Server | null {
  const token = process.env.MEMOAR_METRICS_TOKEN?.trim();
  const port = Number(process.env.MEMOAR_WORKER_METRICS_PORT ?? 9464);
  if (!token) return null;

  const server = createServer((request, response) => {
    void (async () => {
      const supplied = request.headers.authorization?.replace(/^Bearer /u, "");
      if (request.url?.split("?")[0] !== "/metrics") {
        response.writeHead(404).end();
        return;
      }
      if (!supplied || !matches(supplied, token)) {
        response.writeHead(403).end();
        return;
      }
      try {
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
  server.listen(port, process.env.MEMOAR_METRICS_HOST ?? "0.0.0.0");
  return server;
}
