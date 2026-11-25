import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RawArtifactRecord, TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";
import { syntheticClaudeTranscript, syntheticUuid } from "./helpers/claude-transcript.js";

/*
  Claude Desktop's local agent mode keeps a Claude Code home per session, and
  capture now takes its transcripts and subagents from
  `local-agent-mode-sessions/<account>/<org>/local_<id>/.claude/projects/`.
  Checked on 2026-11-25 by key names only: all 27 subagent files there carry
  `isSidechain: true`, an `agentId` matching the file name and the parent's
  `sessionId`, the same as the CLI's. So they must get the same identity the
  CLI's subagents get, `<sessionId>:agent:<agentId>`, through the same path the
  agent's uploads take: the bare `claude-code` header and format detection.

  Everything here is generated.
*/

const context: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000006a1",
  userId: "0191cafe-0000-7000-8000-0000000006a2",
  scopes: ["ingest:write"],
  authType: "machine",
  machineId: "0191cafe-0000-7000-8000-0000000006a3",
};

const PARENT = syntheticUuid("desktop:parent");
const PROJECTS = "/Users/someone/Library/Application Support/Claude/local-agent-mode-sessions/acct-1/org-1/local_s1/.claude/projects/-sessions-outputs";

describe("Claude Desktop local agent mode subagents", () => {
  it("get the sidechain identity a CLI subagent gets, apart from their parent", async () => {
    const store = new DevArchiveStore();
    const objects = new MemoryObjectStorage();
    const pipeline = new IngestPipeline(store, objects);
    let uploads = 0;
    const ingest = async (bytes: Buffer, sourcePath: string) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      uploads += 1;
      const record: RawArtifactRecord = {
        id: `0191cafe-0000-7000-8000-${uploads.toString(16).padStart(12, "0")}`, tenantId: context.tenantId, sessionIds: [],
        sha256, size: bytes.byteLength, objectKey: `raw/${sha256}`, status: "stored", source: "claude-code", sourcePath,
        capturedAt: "2026-11-25T12:00:00.000Z", diagnostic: null,
      };
      await objects.put(record.objectKey, bytes);
      await store.saveRawArtifact(context, record);
      const result = await pipeline.process(context, sha256);
      expect(result.status).toBe("parsed");
      return (await store.getSession(context, result.sessionIds[0]!))!;
    };

    const parent = await ingest(
      syntheticClaudeTranscript({ targetBytes: 6_000, sessionId: PARENT, seed: "desktop-parent", toolOutputBytes: 200 }),
      `${PROJECTS}/${PARENT}.jsonl`,
    );
    const subagent = await ingest(
      syntheticClaudeTranscript({ targetBytes: 4_000, seed: "desktop-agent", toolOutputBytes: 200, subagent: { parentSessionId: PARENT, agentId: "d0e1" } }),
      `${PROJECTS}/${PARENT}/subagents/agent-d0e1.jsonl`,
    );

    expect(parent.source.nativeSessionId).toBe(PARENT);
    expect(subagent.source.nativeSessionId).toBe(`${PARENT}:agent:d0e1`);
    expect(subagent.id).not.toBe(parent.id);
    expect(subagent.ext?.claudeCode).toEqual({ parentNativeSessionId: PARENT, agentId: "d0e1" });
  });
});
