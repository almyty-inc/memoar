import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { ARCHIVE_STORE } from "../src/tokens.js";
import { arr, startTestApi, str, type TestApi } from "./helpers/http-app.js";

let api: TestApi;

beforeAll(async () => { api = await startTestApi(); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

/** Sources on a machine, as the API reports them. */
function sourcesOf(body: { items?: unknown }, machineId: string): { source: string; sessionCount: number }[] {
  const machine = arr(body as never).find((entry) => str(entry, "id") === machineId);
  expect(machine, "the machine is missing from the listing").toBeDefined();
  return (machine!.sources as unknown as { source: string; sessionCount: number }[]);
}

describe("what each machine has captured", () => {
  it("counts the sessions a source produced instead of reporting none", async () => {
    // The machines view exists to say what each source has produced, and the
    // count was never computed: every source on every machine read zero
    // sessions however much had been archived from it.
    const created = await api.request("POST", "/machines", { body: { name: "counted", platform: "darwin" } });
    const machineId = str(created.body, "id");
    await api.request("PATCH", `/machines/${machineId}`, {
      body: { sourceSettings: { "claude-code": { enabled: true }, codex: { enabled: true } } },
    });

    // Two sessions from one source on this machine, one from another.
    const store = api.app.get<DevArchiveStore>(ARCHIVE_STORE);
    for (const [index, tool] of ["claude-code", "claude-code", "codex"].entries()) {
      await store.saveSession(api.context, {
        ...TEST_SESSION,
        id: `0191cafe-0000-7000-8000-00000000c1${index}0`,
        source: { ...TEST_SESSION.source, tool, machineId },
      });
    }

    const listed = await api.request("GET", "/machines");
    const sources = sourcesOf(listed.body, machineId);
    expect(sources.find((source) => source.source === "claude-code")?.sessionCount).toBe(2);
    expect(sources.find((source) => source.source === "codex")?.sessionCount).toBe(1);
  });

  it("does not credit one machine with another's sessions", async () => {
    const first = str((await api.request("POST", "/machines", { body: { name: "first", platform: "linux" } })).body, "id");
    const second = str((await api.request("POST", "/machines", { body: { name: "second", platform: "linux" } })).body, "id");
    for (const id of [first, second]) {
      await api.request("PATCH", `/machines/${id}`, { body: { sourceSettings: { "claude-code": { enabled: true } } } });
    }

    const store = api.app.get<DevArchiveStore>(ARCHIVE_STORE);
    await store.saveSession(api.context, {
      ...TEST_SESSION,
      id: "0191cafe-0000-7000-8000-00000000c200",
      source: { ...TEST_SESSION.source, tool: "claude-code", machineId: first },
    });

    const listed = await api.request("GET", "/machines");
    expect(sourcesOf(listed.body, first)[0]!.sessionCount).toBe(1);
    expect(sourcesOf(listed.body, second)[0]!.sessionCount, "the other machine captured nothing").toBe(0);
  });

  it("reports zero for a machine that has just registered", async () => {
    const created = await api.request("POST", "/machines", { body: { name: "brand new", platform: "windows" } });
    expect(arr(created.body, "sources"), "nothing has been discovered on it yet").toEqual([]);
  });
});
