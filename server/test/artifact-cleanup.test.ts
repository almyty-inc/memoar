import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { judge, runCleanup, type ArtifactOrigin, type CleanupArtifact, type CleanupStore } from "../src/cleanup/artifact-cleanup.js";
import { pipelineReparse } from "../src/cleanup/cleanup-command.js";
import { DENIED_DIRECTORIES, DENIED_NAMES, DENIED_PATTERNS } from "../src/cleanup/never-captured.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";

const TENANT = "0191cafe-0000-7000-8000-0000000000c1";
const HOME = "/Users/someone";
const DESKTOP = `${HOME}/Library/Application Support/Claude/local-agent-mode-sessions/a/b`;

let counter = 0;
function artifact(sourcePath: string | null, overrides: Partial<CleanupArtifact> = {}): CleanupArtifact {
  counter += 1;
  const sha256 = createHash("sha256").update(`${sourcePath}:${counter}`).digest("hex");
  return {
    id: `0191cafe-0000-7000-8000-${counter.toString(16).padStart(12, "0")}`,
    tenantId: TENANT, sha256, objectKey: `tenants/${TENANT}/raw/${sha256}`, status: "unknown_format",
    source: "claude-code", sourcePath, size: 10, capturedAt: "2026-09-17T15:30:00.000Z", sessionCount: 0,
    ...overrides,
  };
}

describe("the deny list the cleanup applies", () => {
  it("is the one the capture agent applies", () => {
    // The server image carries no agent source, so the tables are repeated.
    // This is what keeps the copy honest.
    const rust = readFileSync(resolve(process.cwd(), "../agent/crates/memoar-connectors/src/deny.rs"), "utf8");
    const table = (name: string) => [...(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`, "u").exec(rust)?.[1] ?? "")
      .matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    expect(DENIED_DIRECTORIES).toEqual(table("DENIED_DIRECTORIES"));
    expect(DENIED_NAMES).toEqual(table("DENIED_NAMES"));
    expect(DENIED_PATTERNS).toEqual(table("DENIED_PATTERNS"));
  });
});

describe("which stored artifacts the cleanup deletes", () => {
  it.each([
    `${DESKTOP}/local_x/.audit-key`,
    `${DESKTOP}/local_x/.claude/.claude.json`,
    `${DESKTOP}/local_x/.claude/backups/.claude.json.backup.1700000000000`,
    `${DESKTOP}/local_x/.claude/plugins/marketplaces/official/.git/index`,
    `${DESKTOP}/local_x/.claude/plugins/marketplaces/official/.git/logs/HEAD`,
    `${HOME}/.claude/projects/-repo/1234/.DS_Store`,
    `${DESKTOP}/local_x.json`,
    `${DESKTOP}/debug/x.txt`,
    `${DESKTOP}/local_x/.claude/tasks/t/1.json`,
    `${DESKTOP}/local_x/outputs/deck.pdf`,
    `${HOME}/.claude/projects/-repo/memory/MEMORY.md`,
    `${HOME}/.claude/projects/-repo/1234/subagents/agent-a1.meta.json`,
    `${HOME}/.claude/projects/-repo/1234/tool-results/out.txt`,
    `${HOME}/.claude/history.jsonl`,
    `${DESKTOP}/local_x/audit.jsonl`,
  ])("deletes %s", (path) => {
    expect(judge(artifact(path)).action).toBe("delete");
  });

  it("deletes a key file whatever its status, and keeps anything that produced a session", () => {
    expect(judge(artifact(`${HOME}/.ssh/id_ed25519`, { status: "failed" })).action).toBe("delete");
    expect(judge(artifact(`${HOME}/notes.md`, { sessionCount: 1 })).action).toBe("keep");
    expect(judge(artifact(`${HOME}/.claude/projects/-r/s.jsonl`, { status: "parsed" })).action).toBe("keep");
    expect(judge(artifact(null)).action).toBe("reparse");
  });

  it.each([
    ["claude-code", `${HOME}/.claude/projects/-repo/1234.jsonl`],
    ["claude-code", `${DESKTOP}/local_x/.claude/projects/-o/1234/subagents/agent-a1.jsonl`],
    ["codex", `${HOME}/.codex/sessions/2026/09/17/rollout-2026-09-17T10-00-00-x.jsonl`],
    ["antigravity-cli", `${HOME}/.gemini/antigravity-cli/brain/c/.system_generated/logs/transcript.jsonl`],
  ])("hands a %s transcript back to the parser: %s", (source, path) => {
    expect(judge(artifact(path, { source }))).toEqual({ action: "reparse" });
  });
});

class FakeStore implements CleanupStore {
  constructor(public rows: CleanupArtifact[]) {}
  tenantIds() { return Promise.resolve([TENANT]); }
  artifacts() { return Promise.resolve(this.rows.filter((row) => row.status !== "parsed")); }
  origin(): Promise<ArtifactOrigin | null> { return Promise.resolve(null); }
  remove(row: CleanupArtifact) { this.rows = this.rows.filter((candidate) => candidate.id !== row.id); return Promise.resolve(); }
}

describe("a cleanup run", () => {
  it("lists without touching anything, then deletes rows and bytes once", async () => {
    const key = artifact(`${DESKTOP}/local_x/.audit-key`);
    const transcript = artifact(`${HOME}/.gemini/antigravity-cli/brain/c/.system_generated/logs/transcript.jsonl`, { source: "antigravity-cli" });
    const store = new FakeStore([key, transcript]);
    const objects = new MemoryObjectStorage();
    await objects.put(key.objectKey, new Uint8Array([1]));
    const reparse = (row: CleanupArtifact, apply: boolean) => {
      if (apply) row.status = "parsed";
      return Promise.resolve(apply ? "parsed" : "would reparse");
    };

    const dry = await runCleanup({ store, objects, reparse, apply: false });
    expect(dry.lines.map((line) => [line.action, line.outcome])).toEqual([["delete", "would delete"], ["reparse", "would reparse"]]);
    expect(store.rows).toHaveLength(2);
    await expect(objects.get(key.objectKey)).resolves.toBeDefined();

    const applied = await runCleanup({ store, objects, reparse, apply: true });
    expect(applied.deleted).toEqual({ artifacts: 1, bytes: 10 });
    expect(applied.reparsed).toEqual({ parsed: 1 });
    await expect(objects.get(key.objectKey)).rejects.toThrow();

    const again = await runCleanup({ store, objects, reparse, apply: true });
    expect(again.lines).toEqual([]);
  });

  it("re-parses a refused Antigravity transcript through the real pipeline", async () => {
    // The shape every dev Antigravity artifact has, which the old detector
    // refused as antigravity-cli@unknown.
    const bytes = Buffer.from(`${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T10:00:00Z", content: "rename it" })}\n`);
    const origin: ArtifactOrigin = { userId: "0191cafe-0000-7000-8000-0000000000c2", machineId: "0191cafe-0000-7000-8000-0000000000c3" };
    const context: TenantContext = { tenantId: TENANT, ...origin, scopes: ["ingest:write"], authType: "machine" };
    const archive = new DevArchiveStore();
    const objects = new MemoryObjectStorage();
    const row = artifact(`${HOME}/.gemini/antigravity-cli/brain/c/.system_generated/logs/transcript.jsonl`, { source: "antigravity-cli", size: bytes.byteLength });
    row.sha256 = createHash("sha256").update(bytes).digest("hex");
    await objects.put(row.objectKey, bytes);
    await archive.saveRawArtifact(context, {
      id: row.id, tenantId: TENANT, sessionIds: [], sha256: row.sha256, size: row.size, objectKey: row.objectKey,
      status: "unknown_format", source: row.source, sourcePath: row.sourcePath, capturedAt: row.capturedAt,
      diagnostic: "No parser for antigravity-cli@unknown. Raw bytes were preserved.",
    });
    const store = new FakeStore([row]);
    store.origin = () => Promise.resolve(origin);
    const reparse = pipelineReparse(store, new IngestPipeline(archive, objects), null);

    expect(await reparse(row, false)).toBe(`would reparse as user ${origin.userId} on machine ${origin.machineId}`);
    expect(await reparse(row, true)).toBe("parsed");
    expect((await archive.getRawArtifact(context, row.sha256))?.status).toBe("parsed");
  });
});
