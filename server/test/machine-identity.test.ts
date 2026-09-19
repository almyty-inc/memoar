import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchiveStore } from "../src/archive-store.js";
import { ARCHIVE_STORE } from "../src/tokens.js";
import { FIXTURE_SESSION_ID, obj, startTestApi, str, type TestApi } from "./helpers/http-app.js";

let api: TestApi;

/** A well-formed uuid that names no machine of any account. */
const NO_SUCH_MACHINE = "0191cafe-0000-7000-8000-00000000ff01";
/** A machine that exists, but belongs to somebody else. */
const FOREIGN_MACHINE = "0191cafe-0000-7000-8000-00000000ff02";
const FOREIGN_TENANT = "0191cafe-0000-7000-8000-00000000ff03";

beforeAll(async () => {
  api = await startTestApi();
  const store = api.app.get<ArchiveStore>(ARCHIVE_STORE);
  await store.saveMachine(
    { tenantId: FOREIGN_TENANT, userId: FOREIGN_TENANT, scopes: ["*"], authType: "dev" },
    {
      id: FOREIGN_MACHINE, tenantId: FOREIGN_TENANT, name: "somebody-elses-laptop",
      platform: "darwin", agentVersion: null, sourceSettings: {}, lastSeenAt: null,
    },
  );
}, 30_000);
afterAll(async () => { if (api) await api.close(); });

function capture(machineId: string, path: string) {
  return {
    scope: "project",
    machineId,
    workspacePath: "/workspace/memoar",
    path,
    readers: ["codex"],
    text: "Standing instructions.",
    capturedAt: "2026-09-19T00:00:00.000Z",
  };
}

/** A machine of this account, registered over the API the agent registers with. */
async function ownMachine(name: string): Promise<string> {
  const created = await api.request("POST", "/machines", { body: { name, platform: "darwin" } });
  expect(created.status).toBe(201);
  return str(created.body, "id");
}

describe("a capture is filed under a machine, or not at all", () => {
  it("files under a machine of this account", async () => {
    const machineId = await ownMachine("capture-owner");
    const response = await api.request("POST", "/memory", { body: capture(machineId, "/workspace/memoar/AGENTS.md") });
    expect(response.status).toBe(200);
    expect(obj(response.body, "document").machineId).toBe(machineId);
  });

  it("refuses a machine id that names nothing", async () => {
    // A browser session holds ingest:write, and the guard pins machineId only
    // for machine credentials. Without this check a typo mints a parallel set
    // of documents that no machine owns and no ?machineId= filter reconciles.
    const response = await api.request("POST", "/memory", { body: capture(NO_SUCH_MACHINE, "/workspace/memoar/GHOST.md") });
    expect(response.status).toBe(404);
    expect(response.body.detail ?? response.body.message).toBe("No machine of this account with that id");
  });

  it("refuses another account's machine, and says no more than it says about a missing one", async () => {
    const missing = await api.request("POST", "/memory", { body: capture(NO_SUCH_MACHINE, "/workspace/memoar/GHOST.md") });
    const foreign = await api.request("POST", "/memory", { body: capture(FOREIGN_MACHINE, "/workspace/memoar/GHOST.md") });
    expect(foreign.status).toBe(404);
    expect(foreign.body.detail ?? foreign.body.message).toBe(missing.body.detail ?? missing.body.message);
  });

  it("leaves nothing behind when it refuses", async () => {
    const listed = await api.request("GET", `/memory?machineId=${NO_SUCH_MACHINE}`);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([]);
  });
});

describe("a materialize command is queued for a machine, or not at all", () => {
  async function readyJob(): Promise<string> {
    const job = await api.request("POST", "/convert", { body: { sessionId: FIXTURE_SESSION_ID, target: "claude-code", fallback: "fail" } });
    expect([200, 202]).toContain(job.status);
    return str(job.body, "id");
  }

  it("queues for a machine of this account", async () => {
    const machineId = await ownMachine("materialize-owner");
    const queued = await api.request("POST", `/convert/${await readyJob()}/materialize`, { body: { machineId } });
    expect(queued.status).toBe(202);
  });

  it("refuses a machine id that names nothing", async () => {
    // A command for a machine that does not exist is never delivered and never
    // acked: it sits pending for ever, with no dead-letter to find it in.
    const response = await api.request("POST", `/convert/${await readyJob()}/materialize`, { body: { machineId: NO_SUCH_MACHINE } });
    expect(response.status).toBe(404);
    expect(response.body.detail ?? response.body.message).toBe("No machine of this account with that id");
  });

  it("refuses another account's machine indistinguishably", async () => {
    const missing = await api.request("POST", `/convert/${await readyJob()}/materialize`, { body: { machineId: NO_SUCH_MACHINE } });
    const foreign = await api.request("POST", `/convert/${await readyJob()}/materialize`, { body: { machineId: FOREIGN_MACHINE } });
    expect(foreign.status).toBe(404);
    expect(foreign.body.detail ?? foreign.body.message).toBe(missing.body.detail ?? missing.body.message);
  });
});
