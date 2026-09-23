import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arr, startTestApi, str, type JsonBody, type TestApi } from "./helpers/http-app.js";

/**
 * Machine tokens could not be revoked.
 *
 * Each one was written to `auth_identities` and re-checked there on every
 * request, but nothing set `revokedAt` and `/machines` had no DELETE. One dev
 * account held 19 live machine tokens, 18 of them from a duplicate-machine bug,
 * and a leaked one was good for its full hour whatever anybody did.
 */
let api: TestApi;

beforeAll(async () => { api = await startTestApi({ MACHINE_COMMAND_POLL_MS: "50" }); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

/** Someone signed in to a different archive, through the dev-auth headers. */
const STRANGER = { "x-memoar-tenant": "0191cafe-0000-7000-8000-00000000e5e1", "x-memoar-user": "0191cafe-0000-7000-8000-00000000e5e2" };
const UNKNOWN_MACHINE = "0191cafe-0000-7000-8000-00000000dead";

async function machine(name: string): Promise<string> {
  const created = await api.request("POST", "/machines", { body: { name, platform: "macos" } });
  expect(created.status).toBe(201);
  return str(created.body, "id");
}

async function mint(machineId: string): Promise<string> {
  const minted = await api.request("POST", "/auth/machine-token", { body: { machineId } });
  expect(minted.status).toBe(201);
  return str(minted.body, "token");
}

/** A capture request, which is what a machine token exists to make. */
async function capture(machineId: string, token: string): Promise<number> {
  return (await api.request("POST", "/ingest/delta", { token, body: { machineId, hashes: [] } })).status;
}

async function apiKey(scopes: string[]): Promise<string> {
  const created = await api.request("POST", "/auth/api-keys", { body: { name: scopes.join("+"), scopes } });
  expect(created.status).toBe(201);
  return str(created.body, "secret");
}

describe("revoking a machine's tokens", () => {
  it("refuses a revoked token on its very next request", async () => {
    const machineId = await machine("leaked-laptop");
    const first = await mint(machineId);
    const second = await mint(machineId);
    expect(await capture(machineId, first)).toBe(201);

    const revoked = await api.request("POST", `/machines/${machineId}/tokens/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ revoked: 2 });

    expect(await capture(machineId, first), "a revoked token still captured").toBe(401);
    expect(await capture(machineId, second)).toBe(401);
    // The machine stays, and a token minted now works: this is the agent's
    // own recovery, which mints at the start of every sync cycle.
    expect(await capture(machineId, await mint(machineId))).toBe(201);
    expect((await api.request("POST", `/machines/${machineId}/tokens/revoke`)).body).toEqual({ revoked: 1 });
  });

  it("leaves every other machine's tokens working", async () => {
    const leaked = await machine("revoked-one");
    const other = await machine("untouched-one");
    const leakedToken = await mint(leaked);
    const otherToken = await mint(other);

    await api.request("POST", `/machines/${leaked}/tokens/revoke`);

    expect(await capture(leaked, leakedToken)).toBe(401);
    expect(await capture(other, otherToken), "revoking one machine took another's token").toBe(201);
  });

  it("closes a command stream the revoked token already had open", async () => {
    const machineId = await machine("listening-laptop");
    const token = await mint(machineId);
    const stream = await fetch(`${api.baseUrl}/v1/machines/${machineId}/commands/stream`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await reader.read();

    await api.request("POST", `/machines/${machineId}/tokens/revoke`);

    const ended = await Promise.race([
      (async () => { while (!(await reader.read()).done) { /* pings until it closes */ } return true; })(),
      new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false); }, 3000); }),
    ]);
    await reader.cancel();
    expect(ended, "the stream kept delivering to a revoked token").toBe(true);
  });
});

describe("deregistering a machine", () => {
  it("revokes its tokens and retires it", async () => {
    const machineId = await machine("sold-laptop");
    const token = await mint(machineId);
    const keep = await machine("kept-laptop");
    const keepToken = await mint(keep);

    expect((await api.request("DELETE", `/machines/${machineId}`)).status).toBe(204);

    expect(await capture(machineId, token), "a deregistered machine's token still captured").toBe(401);
    expect(await capture(keep, keepToken)).toBe(201);
    const listed = arr((await api.request("GET", "/machines")).body).map((row) => str(row, "id"));
    expect(listed).not.toContain(machineId);
    expect(listed).toContain(keep);
    expect((await api.request("POST", "/auth/machine-token", { body: { machineId } })).status).toBe(401);
    expect((await api.request("PATCH", `/machines/${machineId}`, { body: { name: "back" } })).status).toBe(404);
    expect((await api.request("DELETE", `/machines/${machineId}`)).status).toBe(404);
    expect((await api.request("POST", `/machines/${machineId}/tokens/revoke`)).status).toBe(404);
  });

  it("enrols the same installation again as a new machine", async () => {
    const body = { name: "reinstalled", platform: "macos", installationId: "installation-deregistered-01" };
    const first = str((await api.request("POST", "/machines", { body })).body, "id");
    await api.request("DELETE", `/machines/${first}`);

    const again = await api.request("POST", "/machines", { body });

    expect(again.status).toBe(201);
    expect(str(again.body, "id")).not.toBe(first);
  });
});

describe("another account", () => {
  for (const [label, method, suffix] of [
    ["deregister", "DELETE", ""],
    ["revoke the tokens of", "POST", "/tokens/revoke"],
  ] as const) {
    it(`cannot ${label} your machine, and cannot tell it exists`, async () => {
      const machineId = await machine(`victim-${method}`);
      const token = await mint(machineId);

      const foreign = await api.request(method, `/machines/${machineId}${suffix}`, { token: null, headers: STRANGER });
      const missing = await api.request(method, `/machines/${UNKNOWN_MACHINE}${suffix}`, { token: null, headers: STRANGER });

      expect(foreign.status).toBe(404);
      // Identical but for the id every response carries for tracing.
      const problem = (body: JsonBody): JsonBody => ({ ...body, requestId: "" });
      expect(problem(foreign.body)).toEqual(problem(missing.body));
      expect(foreign.body.code).toBe("not_found");
      expect(await capture(machineId, token), "a stranger's call revoked the token").toBe(201);
    });
  }
});

describe("the scope both operations cost", () => {
  it("is machines:write, not archive:write", async () => {
    const writer = await apiKey(["archive:read", "archive:write"]);
    const operator = await apiKey(["machines:write"]);
    const machineId = await machine("scoped-laptop");

    for (const [method, path] of [["POST", `/machines/${machineId}/tokens/revoke`], ["DELETE", `/machines/${machineId}`]] as const) {
      const refused = await api.request(method, path, { token: null, headers: { "x-memoar-key": writer } });
      expect(refused.status, `${method} ${path} with archive:write`).toBe(403);
      const allowed = await api.request(method, path, { token: null, headers: { "x-memoar-key": operator } });
      expect(allowed.status, `${method} ${path} with machines:write`).toBeLessThan(300);
    }
  });

  it("is out of reach of the machine's own token", async () => {
    const machineId = await machine("self-revoking");
    const token = await mint(machineId);
    expect((await api.request("POST", `/machines/${machineId}/tokens/revoke`, { token })).status).toBe(403);
    expect((await api.request("DELETE", `/machines/${machineId}`, { token })).status).toBe(403);
  });
});
