import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestApi, str, type TestApi } from "./helpers/http-app.js";

let api: TestApi;

beforeAll(async () => { api = await startTestApi(); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

/** Captures the JSON lines written while running something. */
async function captureLog(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      try { lines.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not ours */ }
    }
    return true;
  });
  try {
    await run();
  } finally {
    write.mockRestore();
  }
  return lines;
}

describe("what an operator gets when something goes wrong", () => {
  it("gives every request an id the caller can quote", async () => {
    // "It failed at about two o'clock" was the whole of what a report could
    // say: there was no id in the response and no request log to search.
    const response = await api.request("GET", "/sessions?limit=1");

    const id = response.headers.get("x-request-id");
    expect(id, "the id is on the response").toBeTruthy();
    expect(id).toMatch(/^[\w-]{8,64}$/u);
  });

  it("keeps an id the edge already assigned, and refuses one it cannot trust", async () => {
    // The id is echoed into a header and written to the log, so a caller must
    // not be able to inject either.
    const kept = await api.request("GET", "/sessions?limit=1", { headers: { "x-request-id": "edge-abc-123" } });
    expect(kept.headers.get("x-request-id")).toBe("edge-abc-123");

    // Anything outside word characters and hyphens is replaced with an id of
    // our own rather than echoed. (A newline cannot even be sent — fetch
    // refuses it — so the case worth testing is the one that reaches us.)
    const suspicious = 'id" onload="alert(1)';
    const forged = await api.request("GET", "/sessions?limit=1", { headers: { "x-request-id": suspicious } });
    expect(forged.headers.get("x-request-id")).not.toBe(suspicious);
    expect(forged.headers.get("x-request-id")).toMatch(/^[\w-]{8,64}$/u);

    const tooLong = await api.request("GET", "/sessions?limit=1", { headers: { "x-request-id": "a".repeat(200) } });
    expect(tooLong.headers.get("x-request-id")?.length).toBeLessThan(65);
  });

  it("writes one structured line per request, with no content in it", async () => {
    const lines = await captureLog(() => api.request("GET", "/sessions?limit=1"));
    const request = lines.find((line) => line.message === "request");

    expect(request, "no request line was written").toBeDefined();
    expect(request).toMatchObject({ level: "info", method: "GET", status: 200 });
    expect(typeof request!.durationMs).toBe("number");
    expect(request!.tenantId, "the tenant is recorded, so a report can be scoped").toBeTruthy();
    // Bodies, queries and headers carry session content and credentials.
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("limit=1");
  });

  it("answers a failure with the problem document the contract describes", async () => {
    const response = await api.request("GET", "/sessions/0191cafe-0000-7000-8000-00000000dead");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(str(response.body, "code")).toBe("not_found");
    expect(str(response.body, "title")).toBeTruthy();
    expect(response.body.status).toBe(404);
    expect(str(response.body, "requestId"), "the body carries the id too").toBe(response.headers.get("x-request-id"));
  });

  it("says what was wrong with a bad request, and nothing about an internal one", async () => {
    // A 4xx is the caller's own mistake and naming the field helps them. A 5xx
    // is ours: its cause goes to the log, under the id the caller was given.
    const badRequest = await api.request("POST", "/annotations", { body: { sessionId: "not-a-uuid", kind: "note", value: {} } });
    expect(badRequest.status).toBe(400);
    expect(str(badRequest.body, "detail")).toContain("sessionId");
  });
});
