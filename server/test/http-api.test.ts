import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arr, obj, str, DEMO_SESSION_ID, startTestApi, type TestApi } from "./helpers/http-app.js";

let api: TestApi;

beforeAll(async () => { api = await startTestApi(); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

describe("HTTP surface: health and auth", () => {
  it("serves unauthenticated health with the generated contract version", async () => {
    const response = await api.request("GET", "/health", { token: null });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", database: "dev-adapter" });
    expect(str(response.body, "contract")).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("rejects unauthenticated archive reads and bad credentials", async () => {
    expect((await api.request("GET", "/sessions", { token: null })).status).toBe(401);
    expect((await api.request("GET", "/sessions", { token: "not-a-token" })).status).toBe(401);
    const badLogin = await api.request("POST", "/auth/login", { token: null, body: { email: "demo@memoar.dev", password: "wrong" } });
    expect(badLogin.status).toBe(401);
  });

  it("mints a distinct machine token per issuance", async () => {
    const machine = await api.request("POST", "/machines", { body: { name: "token-uniqueness", platform: "darwin" } });
    const machineId = str(machine.body, "id");
    // Two issuances inside the same second previously produced byte-identical
    // JWTs, which collided on the token-hash unique index and returned 500.
    const first = await api.request("POST", "/auth/machine-token", { body: { machineId } });
    const second = await api.request("POST", "/auth/machine-token", { body: { machineId } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(str(first.body, "token")).not.toBe(str(second.body, "token"));

    // Both remain usable.
    for (const token of [str(first.body, "token"), str(second.body, "token")]) {
      const stream = await api.request("POST", `/machines/${machineId}/commands/0191cafe-0000-7000-8000-00000000dead/ack`, { body: { status: "completed" }, token });
      expect(stream.status).toBe(404);
    }
  });

  it("serves the reviewed OpenAPI document", async () => {
    const response = await api.request("GET", "/openapi.json", { token: null });
    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe("3.1.0");
    expect(Object.keys(obj(response.body, "paths")).length).toBeGreaterThan(30);
  });
});

describe("HTTP surface: sessions", () => {
  it("lists, reads, and paginates the seeded session", async () => {
    const list = await api.request("GET", "/sessions?limit=10");
    expect(list.status).toBe(200);
    expect(arr(list.body).length).toBeGreaterThan(0);

    const detail = await api.request("GET", `/sessions/${DEMO_SESSION_ID}?chunkSize=1`);
    expect(detail.status).toBe(200);
    expect(arr(detail.body, "turns")).toHaveLength(1);
    expect(detail.body.nextCursor).not.toBeNull();

    const page2 = await api.request("GET", `/sessions/${DEMO_SESSION_ID}?chunkSize=1&cursor=${str(detail.body, "nextCursor")}`);
    expect(page2.status).toBe(200);
    expect(arr(page2.body, "turns")[0]!.id).not.toBe(arr(detail.body, "turns")[0]!.id);
  });

  it("carries provenance on the detail chunk so the client can show how a session arrived", async () => {
    const detail = await api.request("GET", `/sessions/${DEMO_SESSION_ID}`);
    expect(detail.status).toBe(200);
    const provenance = arr(detail.body, "provenance");
    expect(provenance.length).toBeGreaterThan(0);
    expect(provenance[0]).toHaveProperty("kind");
    expect(provenance[0]).toHaveProperty("capturedAt");

    // Summaries stay lean: provenance belongs to the detail view only.
    const list = await api.request("GET", "/sessions?limit=1");
    expect(arr(list.body)[0]).not.toHaveProperty("provenance");
  });

  it("404s unknown sessions and rejects malformed ids", async () => {
    expect((await api.request("GET", "/sessions/0191cafe-0000-7000-8000-00000000dead")).status).toBe(404);
    expect((await api.request("GET", "/sessions/not-a-uuid/export")).status).toBe(400);
  });

  it("exports canonical and HTML with the right content types", async () => {
    const canonical = await api.request("GET", `/sessions/${DEMO_SESSION_ID}/export?format=canonical`);
    expect(canonical.status).toBe(200);
    expect(arr(canonical.body, "sessions")).toHaveLength(1);
    expect((await api.request("GET", `/sessions/${DEMO_SESSION_ID}/export?format=pdf`)).status).toBe(400);
  });

  it("serves the timeline grouped by day", async () => {
    const response = await api.request("GET", "/sessions/timeline");
    expect(response.status).toBe(200);
    expect(arr(response.body, "groups").length).toBeGreaterThan(0);
    expect(arr(response.body, "groups")[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("HTTP surface: request validation", () => {
  it("rejects annotations with a bad kind, missing fields, or unknown properties", async () => {
    const badKind = await api.request("POST", "/annotations", { body: { sessionId: DEMO_SESSION_ID, kind: "nonsense", value: {} } });
    expect(badKind.status).toBe(400);
    expect(JSON.stringify(badKind.body.message)).toContain("kind");

    expect((await api.request("POST", "/annotations", { body: { kind: "note", value: {} } })).status).toBe(400);
    expect((await api.request("POST", "/annotations", { body: { sessionId: DEMO_SESSION_ID, kind: "note", value: {}, injected: true } })).status).toBe(400);
    expect((await api.request("POST", "/annotations", { body: { sessionId: "not-a-uuid", kind: "note", value: {} } })).status).toBe(400);
  });

  it("accepts a valid annotation and round-trips it through the filtered list", async () => {
    const created = await api.request("POST", "/annotations", { body: { sessionId: DEMO_SESSION_ID, kind: "note", value: { text: "http suite" } } });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe("note");

    const listed = await api.request("GET", `/annotations?sessionId=${DEMO_SESSION_ID}`);
    expect(arr(listed.body).some((item) => item.id === created.body.id)).toBe(true);

    const annotationId = str(created.body, "id");
    const updated = await api.request("PATCH", `/annotations/${annotationId}`, { body: { value: { text: "edited" } } });
    expect(updated.status).toBe(200);
    expect(updated.body.value).toEqual({ text: "edited" });

    expect((await api.request("DELETE", `/annotations/${annotationId}`)).status).toBe(204);
    expect((await api.request("DELETE", `/annotations/${annotationId}`)).status).toBe(404);
  });

  it("rejects invalid settings payloads and accepts valid ones", async () => {
    expect((await api.request("PUT", "/settings", { body: { retention: { policy: "forever" } } })).status).toBe(400);
    expect((await api.request("PUT", "/settings", { body: { retention: { policy: "days", days: 0 } } })).status).toBe(400);
    expect((await api.request("PUT", "/settings", { body: { redaction: { secretScan: "yes" } } })).status).toBe(400);

    const ok = await api.request("PUT", "/settings", { body: { retention: { policy: "days", days: 30 } } });
    expect(ok.status).toBe(200);
    expect(ok.body.retention).toMatchObject({ policy: "days", days: 30 });
    await api.request("PUT", "/settings", { body: { retention: { policy: "indefinite" } } });
  });

  it("rejects invalid machine registrations and command acks", async () => {
    expect((await api.request("POST", "/machines", { body: { name: "", platform: "darwin" } })).status).toBe(400);
    expect((await api.request("POST", "/machines", { body: { name: "laptop" } })).status).toBe(400);

    const machine = await api.request("POST", "/machines", { body: { name: "http-suite", platform: "darwin", agentVersion: "test" } });
    expect(machine.status).toBe(201);
    const machineId = str(machine.body, "id");

    // Browser tokens lack materialize:read, so the command channel is scope-gated
    // before any body validation runs.
    const wrongScope = await api.request("POST", `/machines/${machineId}/commands/0191cafe-0000-7000-8000-00000000dead/ack`, { body: { status: "completed" } });
    expect(wrongScope.status).toBe(403);

    const machineToken = await api.request("POST", "/auth/machine-token", { body: { machineId } });
    expect(machineToken.status).toBe(201);
    const asMachine = str(machineToken.body, "token");
    const badStatus = await api.request("POST", `/machines/${machineId}/commands/0191cafe-0000-7000-8000-00000000dead/ack`, { body: { status: "later" }, token: asMachine });
    expect(badStatus.status).toBe(400);
    const unknownCommand = await api.request("POST", `/machines/${machineId}/commands/0191cafe-0000-7000-8000-00000000dead/ack`, { body: { status: "completed" }, token: asMachine });
    expect(unknownCommand.status).toBe(404);
  });

  it("rejects malformed ingest manifests and delta requests", async () => {
    expect((await api.request("POST", "/ingest/manifests", { body: {} })).status).toBe(400);
    expect((await api.request("POST", "/ingest/manifests", { body: { machineId: "not-a-uuid", batchId: "b", artifacts: [] } })).status).toBe(400);
    expect((await api.request("POST", "/ingest/manifests", {
      body: { machineId: "0191cafe-0000-7000-8000-0000000000a1", batchId: "b", artifacts: [{ sha256: "too-short" }] },
    })).status).toBe(400);
    const machine = await api.request("POST", "/machines", { body: { name: "delta-suite", platform: "darwin" } });
    const machineId = str(machine.body, "id");
    // machineId is contract-required on delta negotiation.
    expect((await api.request("POST", "/ingest/delta", { body: { hashes: [] } })).status).toBe(400);
    expect((await api.request("POST", "/ingest/delta", { body: { machineId, hashes: ["nope"] } })).status).toBe(400);
    const emptyDelta = await api.request("POST", "/ingest/delta", { body: { machineId, hashes: [] } });
    expect(emptyDelta.status).toBe(201);
  });

  it("rejects collections with an empty name and unknown team membership", async () => {
    expect((await api.request("POST", "/collections", { body: { name: "" } })).status).toBe(400);
    const foreignTeam = await api.request("POST", "/collections", { body: { name: "x", teamId: "0191cafe-0000-7000-8000-00000000beef" } });
    expect(foreignTeam.status).toBe(403);
  });
});

describe("HTTP surface: sharing and visibility", () => {
  it("requires a current review before widening visibility or sharing", async () => {
    const widen = await api.request("PATCH", `/sessions/${DEMO_SESSION_ID}`, { body: { visibility: { scope: "link" } } });
    expect(widen.status).toBe(409);
    expect(widen.body.code).toBe("redaction_review_required");

    const link = await api.request("POST", "/sharing/links", {
      body: { sessionId: DEMO_SESSION_ID, permission: "viewer", redactionReviewId: "0191cafe-0000-7000-8000-00000000dead" },
    });
    expect(link.status).toBe(409);
  });

  it("completes a review, shares a link, consumes it unauthenticated, and revokes it", async () => {
    const review = await api.request("POST", `/sessions/${DEMO_SESSION_ID}/redaction-reviews`);
    expect(review.status).toBe(201);

    const link = await api.request("POST", "/sharing/links", {
      body: { sessionId: DEMO_SESSION_ID, permission: "viewer", redactionReviewId: str(review.body, "id") },
    });
    expect(link.status).toBe(201);
    const token = str(link.body, "token");

    const consumed = await api.request("GET", `/shares/${token}`, { token: null });
    expect(consumed.status).toBe(200);
    expect(consumed.body.permission).toBe("viewer");
    expect(obj(consumed.body, "session").redactionStatus).toBeUndefined();

    expect((await api.request("POST", `/shares/${token}/import`)).status).toBe(403);
    expect((await api.request("DELETE", `/sharing/grants/${str(link.body, "id")}`)).status).toBe(204);
    expect((await api.request("GET", `/shares/${token}`, { token: null })).status).toBe(404);
  });

  it("widens visibility once a current review exists and narrows without one", async () => {
    const review = await api.request("POST", `/sessions/${DEMO_SESSION_ID}/redaction-reviews`);
    const widened = await api.request("PATCH", `/sessions/${DEMO_SESSION_ID}`, {
      body: { visibility: { scope: "link" }, redactionReviewId: str(review.body, "id") },
    });
    expect(widened.status).toBe(200);
    expect(obj(widened.body, "visibility").scope).toBe("link");

    const narrowed = await api.request("PATCH", `/sessions/${DEMO_SESSION_ID}`, { body: { visibility: { scope: "private" } } });
    expect(narrowed.status).toBe(200);
    expect(obj(narrowed.body, "visibility").scope).toBe("private");
  });
});

describe("HTTP surface: teams, search, and distillation", () => {
  it("creates a team, gates reads on membership, and shares collections", async () => {
    const team = await api.request("POST", "/teams", { body: { name: "http-suite-team" } });
    expect(team.status).toBe(201);
    const teamId = str(team.body, "id");

    expect((await api.request("GET", `/teams/${teamId}/sessions`)).status).toBe(200);
    expect((await api.request("GET", "/teams/0191cafe-0000-7000-8000-00000000beef/sessions")).status).toBe(403);

    const collection = await api.request("POST", "/collections", { body: { name: "team picks", teamId } });
    expect(collection.status).toBe(201);
    const teamCollections = await api.request("GET", `/teams/${teamId}/collections`);
    expect(arr(teamCollections.body)).toHaveLength(1);

    const missingAccount = await api.request("PUT", `/teams/${teamId}/members`, { body: { email: "nobody@example.test" } });
    expect(missingAccount.status).toBe(404);
    expect((await api.request("PUT", `/teams/${teamId}/members`, { body: { email: "not-an-email" } })).status).toBe(400);
  });

  it("searches with aggregations and honours the requested mode", async () => {
    const response = await api.request("GET", "/search?q=archive");
    expect(response.status).toBe(200);
    expect(obj(response.body, "meta").requestedMode).toBe("hybrid");
    expect(response.body.meta).toHaveProperty("realizedMode");
    expect(response.body).toHaveProperty("aggregations");
  });

  it("requires distillation opt-in and validates its settings", async () => {
    const disabled = await api.request("POST", `/distillation/sessions/${DEMO_SESSION_ID}`);
    expect(disabled.status).toBe(409);
    expect(disabled.body.code).toBe("distillation_not_opted_in");

    expect((await api.request("PUT", "/distillation/settings", { body: { monthlyBudgetCents: -1 } })).status).toBe(400);
    const enabled = await api.request("PUT", "/distillation/settings", { body: { enabled: true, monthlyBudgetCents: 100 } });
    expect(enabled.status).toBe(200);
    expect(enabled.body.remainingCents).toBe(100);

    const capped = await api.request("POST", `/distillation/sessions/${DEMO_SESSION_ID}`);
    expect(capped.status).toBe(409);
    expect(capped.body.code).toBe("distillation_cost_cap_exceeded");
    await api.request("PUT", "/distillation/settings", { body: { enabled: false, monthlyBudgetCents: 0 } });
  });
});

describe("HTTP surface: collections and conversion", () => {
  it("manages collection membership through the documented status codes", async () => {
    const collection = await api.request("POST", "/collections", { body: { name: "membership", description: "http suite" } });
    const collectionId = str(collection.body, "id");

    expect((await api.request("PUT", `/collections/${collectionId}/sessions/${DEMO_SESSION_ID}`)).status).toBe(204);
    const members = await api.request("GET", `/collections/${collectionId}/sessions`);
    expect(arr(members.body)).toHaveLength(1);
    expect((await api.request("DELETE", `/collections/${collectionId}/sessions/${DEMO_SESSION_ID}`)).status).toBe(204);
    expect(arr((await api.request("GET", `/collections/${collectionId}/sessions`)).body)).toHaveLength(0);
    expect((await api.request("GET", "/collections/0191cafe-0000-7000-8000-00000000dead/sessions")).status).toBe(404);
  });

  it("converts to a native target and to an open target through injection fallback", async () => {
    const native = await api.request("POST", "/convert", { body: { sessionId: DEMO_SESSION_ID, target: "claude-code", fallback: "fail" } });
    expect(native.status).toBe(202);
    expect(native.body.status).toBe("ready");

    const open = await api.request("POST", "/convert", { body: { sessionId: DEMO_SESSION_ID, target: "aider", fallback: "injection" } });
    expect(open.body.status).toBe("ready");
    expect(obj(open.body, "report").fallback).toBe(true);

    const failed = await api.request("POST", "/convert", { body: { sessionId: DEMO_SESSION_ID, target: "aider", fallback: "fail" } });
    expect(failed.body.status).toBe("failed");

    const job = await api.request("GET", `/convert/${str(native.body, "id")}`);
    expect(job.status).toBe(200);
    expect(job.body.status).toBe("ready");
  });

  it("rejects malformed conversion and materialize bodies", async () => {
    expect((await api.request("POST", "/convert", { body: { sessionId: DEMO_SESSION_ID, target: "", fallback: "fail" } })).status).toBe(400);
    expect((await api.request("POST", "/convert", { body: { sessionId: DEMO_SESSION_ID, target: "claude-code", fallback: "maybe" } })).status).toBe(400);
    const job = await api.request("POST", "/convert", { body: { sessionId: DEMO_SESSION_ID, target: "claude-code", fallback: "fail" } });
    // An empty machineId used to reach Postgres and surface as a 500.
    expect((await api.request("POST", `/convert/${str(job.body, "id")}/materialize`, { body: { machineId: "" } })).status).toBe(400);
  });

  it("validates the pack body instead of letting it reach SQL, and answers 200", async () => {
    const valid = {
      query: "parser", maxTokens: 2000, maxEvidence: 5,
      maxSessions: 3, maxExcerptChars: 400, freshnessPolicy: "mixed",
    };
    // PackRequest was an interface, so the ValidationPipe had no metadata to act
    // on and the body passed through untouched: an absent query and unparsable
    // limits reached Postgres, which rejected NaN as a bigint and returned 500.
    const malformed = await api.request("POST", "/pack", { body: { sessionIds: [DEMO_SESSION_ID], budgetTokens: 2000 } });
    expect(malformed.status).toBe(400);
    expect((await api.request("POST", "/pack", { body: { ...valid, maxTokens: 99_999 } })).status).toBe(400);
    expect((await api.request("POST", "/pack", { body: { ...valid, freshnessPolicy: "whenever" } })).status).toBe(400);

    const built = await api.request("POST", "/pack", { body: valid });
    // A pack is a projection over existing sessions, not a created resource;
    // Nest's default 201 for POST contradicted the contract's documented 200.
    expect(built.status).toBe(200);
    expect(arr(built.body, "evidence").length).toBeGreaterThan(0);
  });

  it("queues a materialize command carrying a pre-signed bundle URL", async () => {
    const machine = await api.request("POST", "/machines", { body: { name: "materialize-suite", platform: "darwin" } });
    const machineId = str(machine.body, "id");
    const job = await api.request("POST", "/convert", { body: { sessionId: DEMO_SESSION_ID, target: "claude-code", fallback: "fail" } });
    const queued = await api.request("POST", `/convert/${str(job.body, "id")}/materialize`, { body: { machineId } });
    expect(queued.status).toBe(202);

    // The agent reads commands with a machine token on its own channel only.
    const machineToken = await api.request("POST", "/auth/machine-token", { body: { machineId } });
    const asMachine = str(machineToken.body, "token");
    const stream = await fetch(`${api.baseUrl}/v1/machines/${machineId}/commands/stream`, {
      headers: { authorization: `Bearer ${asMachine}` },
      signal: AbortSignal.timeout(3000),
    }).catch((error: unknown) => error);
    expect(stream).toBeInstanceOf(Response);

    const reader = (stream as Response).body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: command")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value as Uint8Array);
    }
    await reader.cancel();
    const payload = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!) as { kind: string; payload: { downloadUrl?: string; jobId?: string } };
    expect(payload.kind).toBe("materialize");
    expect(payload.payload.jobId).toBe(str(job.body, "id"));
    expect(typeof payload.payload.downloadUrl).toBe("string");
  }, 20_000);
});
