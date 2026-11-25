import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";
import { EMPTY_DIAGNOSTIC_PREFIX } from "../src/ingest/pipeline.js";

/*
  A file that holds no conversation is not a file the archive failed to read.

  On 2026-11-25 `memoar doctor` on a healthy install reported
  `artifacts_parsed: copilot: 23, codex: 2`. The 23 were VS Code chat panels
  opened and never used, `requests: []`, and the 2 were Codex guardian threads
  holding one encrypted compaction. Both were refused correctly and stored as
  `unknown_format`, which `/ingest/unparsed` counts as a capture fault. They
  are now `parsed` with no session and say why, and only real refusals reach
  the count. Every value below is invented.
*/

const context: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000e1",
  userId: "0191cafe-0000-7000-8000-0000000000e2",
  scopes: ["ingest:write"],
  authType: "machine",
  machineId: "0191cafe-0000-7000-8000-0000000000e3",
};

const AT = "2026-08-01T00:00:00.000Z";

const unusedPanel = JSON.stringify({ kind: 0, v: { version: 3, requests: [], sessionId: "panel-1", creationDate: 1_743_594_617_151 } });

const guardianThread = [
  { timestamp: AT, type: "session_meta", payload: { id: "rollout-1", timestamp: AT, cwd: "/workspace/demo" } },
  { timestamp: AT, type: "response_item", payload: { type: "compaction", id: "cmp_1", encrypted_content: "b3BhcXVl" } },
  { timestamp: AT, type: "event_msg", payload: { type: "thread_settings_applied", thread_id: "t" } },
].map((record) => JSON.stringify(record)).join("\n");

const unreadablePanel = JSON.stringify({ version: 3, requests: [{ somethingNew: true }], sessionId: "panel-2", creationDate: 1_743_594_617_151 });

async function stored(store: DevArchiveStore, objects: MemoryObjectStorage, source: string, sourcePath: string, text: string): Promise<string> {
  const bytes = Buffer.from(`${text}\n`, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `tenants/${context.tenantId}/raw/${sha256}`;
  await objects.put(objectKey, bytes);
  await store.saveRawArtifact(context, {
    id: `0191cafe-0000-7000-8000-${sha256.slice(0, 12)}`,
    tenantId: context.tenantId,
    sessionIds: [],
    sha256,
    size: bytes.byteLength,
    objectKey,
    status: "stored",
    source,
    sourcePath,
    capturedAt: AT,
    diagnostic: null,
  });
  return sha256;
}

describe("an artifact that holds no conversation", () => {
  it.each([
    ["copilot", "chatSessions/panel-1.jsonl", unusedPanel, "holds no requests"],
    ["codex", "sessions/rollout-2026-08-01-guardian.jsonl", guardianThread, "only compactions"],
  ])("%s is parsed with no session and is not counted as unparsed", async (source, sourcePath, text, reason) => {
    const store = new DevArchiveStore();
    const objects = new MemoryObjectStorage();
    const sha256 = await stored(store, objects, source, sourcePath, text);

    const outcome = await new IngestPipeline(store, objects).process(context, sha256);

    expect(outcome).toEqual({ status: "parsed", sessionIds: [] });
    const artifact = await store.getRawArtifact(context, sha256);
    expect(artifact!.status).toBe("parsed");
    expect(artifact!.sessionIds).toEqual([]);
    expect(artifact!.diagnostic!.startsWith(EMPTY_DIAGNOSTIC_PREFIX), artifact!.diagnostic ?? "").toBe(true);
    expect(artifact!.diagnostic).toContain(reason);
    expect(await store.listSessions(context, { limit: 50 }).then((page) => page.items), "no session with no turns").toEqual([]);
    expect(await store.countUnparsedArtifactsBySource(context)).toEqual([]);
  });

  it("leaves a real refusal beside it counted", async () => {
    const store = new DevArchiveStore();
    const objects = new MemoryObjectStorage();
    const empty = await stored(store, objects, "copilot", "chatSessions/panel-1.jsonl", unusedPanel);
    const unreadable = await stored(store, objects, "copilot", "chatSessions/panel-2.json", unreadablePanel);
    const pipeline = new IngestPipeline(store, objects);

    await pipeline.process(context, empty);
    await pipeline.process(context, unreadable);

    expect((await store.getRawArtifact(context, unreadable))!.status).toBe("unknown_format");
    expect(await store.countUnparsedArtifactsBySource(context)).toEqual([
      { source: "copilot", artifacts: 1, diagnostic: "copilot v1 chat session has requests and none of them could be read" },
    ]);
  });
});
