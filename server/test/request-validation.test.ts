import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_SESSION_ID, startTestApi, str, type TestApi } from "./helpers/http-app.js";

/**
 * Caller mistakes that used to reach the database.
 *
 * An unvalidated path parameter or query value went straight to SQL, where
 * Postgres refused `NaN` as a bigint and `Invalid Date` as a timestamp — and
 * the caller's typo came back as a 500, logged with a stack and fingerprinted
 * as a fault of ours. search.dto.ts already says, in a comment, that exactly
 * this was fixed for /pack; /search kept it.
 *
 * Every assertion below is that the answer is 400: the request is malformed,
 * which is the caller's to fix and ours to say plainly. A lookup that quietly
 * misses is not an answer to "you sent nonsense".
 */
let api: TestApi;

/** Scopes a signed-in person does not hold (materialize:read) need the dev identity. */
const DEV = { authorization: "Bearer memoar-development-token" };
const A_UUID = "0191cafe-0000-7000-8000-00000000d002";

beforeAll(async () => { api = await startTestApi(); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

describe("a malformed identifier in the path", () => {
  it("is a bad request on every route that takes one", async () => {
    const cases: [string, string, Record<string, unknown> | undefined][] = [
      ["PATCH", "/machines/not-a-uuid", { name: "renamed" }],
      ["GET", "/convert/not-a-uuid", undefined],
      ["GET", "/convert/not-a-uuid/download", undefined],
      ["GET", "/distillation/jobs/not-a-uuid", undefined],
      ["POST", "/distillation/sessions/not-a-uuid", undefined],
      ["GET", "/teams/not-a-uuid/sessions", undefined],
      ["GET", "/teams/not-a-uuid/collections", undefined],
      ["DELETE", `/teams/${A_UUID}/members/not-a-uuid`, undefined],
    ];
    for (const [method, path, body] of cases) {
      const response = await api.request(method, path, body === undefined ? {} : { body });
      expect(response.status, `${method} ${path}`).toBe(400);
    }
  });

  it("is a bad request on a machine's own command channel too", async () => {
    const response = await api.request("POST", `/machines/${A_UUID}/commands/not-a-uuid/ack`, {
      token: null, headers: DEV, body: { status: "completed" },
    });

    expect(response.status).toBe(400);
  });
});

describe("a malformed query value", () => {
  it("is refused rather than reaching the search backend", async () => {
    // Number.parseInt("abc") is NaN and NaN reached `LIMIT $n`; new Date("yesterday")
    // is an Invalid Date and that reached the comparison.
    for (const query of ["limit=abc", "limit=0", "limit=10000", "from=yesterday", "to=whenever", "mode=telepathy"]) {
      const response = await api.request("GET", `/search?q=archive&${query}`);
      expect(response.status, `/search?${query}`).toBe(400);
    }
    // And a well-formed one still works, so this is a bound and not a wall.
    expect((await api.request("GET", "/search?q=archive&limit=5&from=2026-01-01T00:00:00.000Z")).status).toBe(200);
  });

  it("is refused on the project-memory export, which needs a workspace to export", async () => {
    // `@Query("workspace") workspace: string` is undefined when it is absent,
    // and the format was typed as a union the pipe never saw.
    expect((await api.request("POST", "/distillation/projects/export")).status).toBe(400);
    expect((await api.request("POST", "/distillation/projects/export?workspace=/w&format=telepathy")).status).toBe(400);
  });

  it("is refused on the memory listing, which takes a machine id", async () => {
    expect((await api.request("GET", "/memory?machineId=not-a-uuid")).status).toBe(400);
    expect((await api.request("GET", "/memory?scope=elsewhere")).status).toBe(400);
    expect((await api.request("GET", `/memory?machineId=${A_UUID}&scope=global`)).status).toBe(200);
  });
});

describe("values that end up inside something else", () => {
  it("holds a conversion target to the shape of a tool name", async () => {
    // It is interpolated into the resume command a person is told to run and
    // copied into a machine command payload, and it was any string at all.
    for (const target of ["claude; rm -rf /", "$(whoami)", "a".repeat(200), "../../etc/passwd", "Claude Code"]) {
      const response = await api.request("POST", "/convert", {
        body: { sessionId: FIXTURE_SESSION_ID, target, fallback: "injection" },
      });
      expect(response.status, `target ${JSON.stringify(target)}`).toBe(400);
    }
    expect((await api.request("POST", "/convert", {
      body: { sessionId: FIXTURE_SESSION_ID, target: "claude-code", fallback: "injection" },
    })).status).toBe(202);
  });

  it("bounds a custom redaction pattern's length as well as the count of them", async () => {
    // Every pattern is compiled and run over every block of every shared
    // session; count was capped and length was not.
    const response = await api.request("PUT", "/settings", {
      body: { redaction: { customPatterns: ["a".repeat(1000)] } },
    });

    expect(response.status).toBe(400);
  });

  it("bounds the readers a memory capture may name", async () => {
    // Ingest caps its arrays at 10,000 and pins digests by regex; this array
    // had no bound at all, so one capture could carry as much storage as the
    // agent cared to send.
    const response = await api.request("POST", "/memory", {
      body: {
        scope: "project", machineId: A_UUID, path: "/workspace/memoar/AGENTS.md",
        readers: Array.from({ length: 500 }, (_, index) => `agent-${index}`),
        text: "rules", capturedAt: "2026-08-17T09:00:00.000Z",
      },
    });

    expect(response.status).toBe(400);
  });

  it("holds the ingest source headers to a shape before storing them", async () => {
    const digest = "a".repeat(64);
    const response = await fetch(`${api.baseUrl}/v1/ingest/artifacts/${digest}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${api.token}`,
        "content-type": "application/octet-stream",
        "x-memoar-source": "../../etc/passwd",
        "x-memoar-source-path": "/tmp/x",
      },
      body: Buffer.from("not a transcript"),
    });

    expect(response.status).toBe(400);
    expect(str(await response.json() as Record<string, never>, "detail")).toContain("x-memoar-source");
  });
});
