import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arr, FIXTURE_SESSION_ID, obj, startTestApi, str, type TestApi } from "./helpers/http-app.js";

let api: TestApi;
let teamId = "";
/** A key that can write the archive but was never given the sharing scope. */
let archiveOnlyKey = "";

beforeAll(async () => {
  api = await startTestApi();
  const team = await api.request("POST", "/teams", { body: { name: "workspace" } });
  teamId = str(team.body, "id");
  const key = await api.request("POST", "/auth/api-keys", {
    body: { name: "archive only", scopes: ["archive:read", "archive:write"] },
  });
  archiveOnlyKey = str(key.body, "secret");
}, 120_000);

afterAll(async () => { await api.close(); });

function withArchiveOnlyKey() {
  return { token: null, headers: { "x-memoar-key": archiveOnlyKey } };
}

/**
 * The team workspace over HTTP: the routes exist, they are in the contract, and
 * the two that decide what other people may read ask for the scope that says so.
 */
describe("team workspace routes", () => {
  it("starts with nothing shared", async () => {
    const response = await api.request("GET", `/teams/${teamId}/optins`);
    expect(response.status).toBe(200);
    expect(arr(response.body)).toEqual([]);
  });

  it("enrols and withdraws through the documented shapes", async () => {
    const enrolled = await api.request("PUT", `/teams/${teamId}/optins`, { body: {} });
    expect(enrolled.status).toBe(200);
    expect(enrolled.body).toMatchObject({ teamId, machineId: null });

    expect(arr((await api.request("GET", `/teams/${teamId}/optins`)).body)).toHaveLength(1);

    const removed = await api.request("DELETE", `/teams/${teamId}/optins/all`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ teamId, machineId: null, revokedSessions: 0 });
    expect(arr((await api.request("GET", `/teams/${teamId}/optins`)).body)).toEqual([]);
  });

  it("refuses a body field the contract does not describe", async () => {
    const response = await api.request("PUT", `/teams/${teamId}/optins`, { body: { everything: true } });
    expect(response.status).toBe(400);
  });

  /*
    Deciding who else may read an archive is a sharing act.

    The guard infers scopes from the path, and nothing under /teams matches a
    special branch, so every write here was inferred as archive:write — the
    scope for writing one's own archive. A key handed out for capture could
    therefore add somebody to a team, and now enrol a whole tenant's capture
    into one.
  */
  it("asks for the sharing scope before anything changes who can read", async () => {
    const enrol = await api.request("PUT", `/teams/${teamId}/optins`, { body: {}, ...withArchiveOnlyKey() });
    expect(enrol.status).toBe(403);
    expect(str(enrol.body, "detail")).toContain("sharing:write");

    const revoke = await api.request("DELETE", `/teams/${teamId}/optins/all`, withArchiveOnlyKey());
    expect(revoke.status).toBe(403);

    const invite = await api.request("PUT", `/teams/${teamId}/members`, {
      body: { email: "somebody@example.test" }, ...withArchiveOnlyKey(),
    });
    expect(invite.status).toBe(403);
    expect(str(invite.body, "detail")).toContain("sharing:write");
  });

  it("still lets a signed-in person invite, because a browser session holds that scope", async () => {
    // The other half of the check above: tightening the scope must not lock out
    // the web app, whose token is minted by an ordinary password sign-in.
    const invite = await api.request("PUT", `/teams/${teamId}/members`, { body: { email: "nobody@example.test" } });
    expect(invite.status).toBe(404);
  });

  it("reads the archive over a team without leaving the single-tenant queries behind", async () => {
    const search = await api.request("GET", `/teams/${teamId}/search?q=parser&mode=lexical`);
    expect(search.status).toBe(200);
    // The fixture session is private, so a team search finds nothing — and the
    // response is still the shape /search returns.
    expect(arr(search.body)).toEqual([]);
    expect(obj(search.body, "meta")).toMatchObject({ requestedMode: "lexical", realizedMode: "lexical" });
    expect(obj(search.body, "aggregations")).toBeDefined();
  });

  it("will not hand over a session that was never widened to the team", async () => {
    const response = await api.request("GET", `/teams/${teamId}/sessions/${FIXTURE_SESSION_ID}`);
    expect(response.status).toBe(404);
  });

  it("refuses every team route to somebody who is not a member", async () => {
    const stranger = "0191cafe-0000-7000-8000-00000000f9f9";
    expect((await api.request("GET", `/teams/${stranger}/optins`)).status).toBe(403);
    expect((await api.request("GET", `/teams/${stranger}/search?q=parser`)).status).toBe(403);
    expect((await api.request("GET", `/teams/${stranger}/sessions/${FIXTURE_SESSION_ID}`)).status).toBe(403);
  });
});
