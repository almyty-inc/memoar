import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session } from "../libs/canonical/src/generated.js";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";
import type { RawArtifactRecord, TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { IngestPipeline, MemoryObjectStorage, SUPERSEDED_DIAGNOSTIC } from "../src/ingest.js";
import { syntheticClaudeTranscript, syntheticUuid } from "./helpers/claude-transcript.js";

/*
  A Claude Code subagent writes its own transcript, one directory below the
  session that spawned it, and every line names the parent's session id. Read as
  the transcript's own id, the parent and all its subagents became one archive
  session, and since a capture replaces the session it saves, whichever file was
  parsed last erased the rest. On dev one session was written by 94 files and
  held the turns of one of them.

  Everything here is generated. No line comes from a real transcript.
*/

const context: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000005a1",
  userId: "0191cafe-0000-7000-8000-0000000005a2",
  scopes: ["ingest:write"],
  authType: "machine",
  machineId: "0191cafe-0000-7000-8000-0000000005a3",
};

const PARENT = syntheticUuid("subagents:parent");
const PROJECT = "/home/dev/.claude/projects/-workspace-synthetic";

class Archive {
  readonly store = new DevArchiveStore();
  private readonly objects = new MemoryObjectStorage();
  private readonly pipeline = new IngestPipeline(this.store, this.objects);
  private uploads = 0;

  /** Stores the bytes as the ingest endpoint would, without parsing them. */
  async upload(bytes: Buffer, sourcePath: string, capturedAt = "2026-11-25T12:00:00.000Z"): Promise<RawArtifactRecord> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `raw/${sha256}`;
    await this.objects.put(objectKey, bytes);
    this.uploads += 1;
    const record: RawArtifactRecord = {
      id: `0191cafe-0000-7000-8000-${this.uploads.toString(16).padStart(12, "0")}`, tenantId: context.tenantId, sessionIds: [],
      sha256, size: bytes.byteLength, objectKey, status: "stored", source: "claude-code", sourcePath, capturedAt, diagnostic: null,
    };
    await this.store.saveRawArtifact(context, record);
    return record;
  }

  async parse(artifact: RawArtifactRecord): Promise<string> {
    const result = await this.pipeline.process(context, artifact.sha256);
    expect(result.sessionIds).toHaveLength(1);
    return result.sessionIds[0]!;
  }

  async turns(sessionId: string): Promise<number> {
    return (await this.store.getSession(context, sessionId))!.turns.length;
  }
}

function turnCount(bytes: Buffer): number {
  return bytes.toString("utf8").trim().split("\n").length;
}

const parent = syntheticClaudeTranscript({ targetBytes: 40_000, sessionId: PARENT, seed: "parent", toolOutputBytes: 400 });
const first = syntheticClaudeTranscript({ targetBytes: 12_000, seed: "agent-one", toolOutputBytes: 400, subagent: { parentSessionId: PARENT, agentId: "a0f1" } });
const second = syntheticClaudeTranscript({ targetBytes: 8_000, seed: "agent-two", toolOutputBytes: 400, subagent: { parentSessionId: PARENT, agentId: "a0f2" } });

describe("the subagent-1 contract fixture", () => {
  const fixture = resolve(process.cwd(), "../contracts/fixtures/claude-code/v1/subagent-1");
  async function load(): Promise<{ raw: Buffer; expected: Session }> {
    const [raw, expected] = await Promise.all([
      readFile(resolve(fixture, "input/session.jsonl")),
      readFile(resolve(fixture, "expected.canonical.json"), "utf8"),
    ]);
    return { raw, expected: JSON.parse(expected) as Session };
  }

  it("normalizes byte-exact", async () => {
    const { raw, expected } = await load();
    const seed = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "turns")) as SessionSeed;
    const result = new ParserRegistry().parse({ source: "claude-code", version: "v1", raw, seed });
    expect(result.kind).toBe("parsed");
    if (result.kind === "parsed") expect(result.sessions).toEqual([expected]);
  });

  it("takes its identity and its parent link from the file, not from the seed", async () => {
    // The byte-exact case seeds from the expected output, which already holds
    // both, so on its own it cannot tell a parser that reads them from one
    // that passes them through.
    const { raw, expected } = await load();
    const base = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "turns")) as SessionSeed;
    const seed: SessionSeed = {
      ...base,
      source: { ...expected.source, nativeSessionId: "seed-native-id" },
      ext: { fixtureSource: "claude-code" },
    };
    const result = new ParserRegistry().parse({ source: "claude-code", version: "v1", raw, seed });
    if (result.kind !== "parsed") throw new Error("the fixture did not parse");
    expect(result.sessions[0]!.source.nativeSessionId).toBe(expected.source.nativeSessionId);
    expect(result.sessions[0]!.ext).toEqual(expected.ext);
  });
});

describe("Claude Code subagent transcripts", () => {
  it("archives a parent and each subagent as their own sessions, in any parse order", async () => {
    const archive = new Archive();
    const one = await archive.upload(first, `${PROJECT}/${PARENT}/subagents/agent-a0f1.jsonl`);
    const main = await archive.upload(parent, `${PROJECT}/${PARENT}.jsonl`);
    const two = await archive.upload(second, `${PROJECT}/${PARENT}/subagents/workflows/w1/agent-a0f2.jsonl`);

    const ids = [await archive.parse(one), await archive.parse(main), await archive.parse(two)];

    expect(new Set(ids).size, "three conversations, three sessions").toBe(3);
    expect(await archive.turns(ids[0]!)).toBe(turnCount(first));
    expect(await archive.turns(ids[1]!), "the parent keeps every turn of its own").toBe(turnCount(parent));
    expect(await archive.turns(ids[2]!)).toBe(turnCount(second));

    const parentSession = (await archive.store.getSession(context, ids[1]!))!;
    expect(parentSession.source.nativeSessionId, "a main transcript keeps the id it always had").toBe(PARENT);
    expect(parentSession.ext?.claudeCode).toBeUndefined();
    const subagent = (await archive.store.getSession(context, ids[0]!))!;
    expect(subagent.source.nativeSessionId).toBe(`${PARENT}:agent:a0f1`);
    expect(subagent.ext?.claudeCode, "and says which conversation spawned it").toEqual({ parentNativeSessionId: PARENT, agentId: "a0f1" });
  });

  it("moves a subagent the old parser merged into its parent back out, and leaves the parent whole", async () => {
    const archive = new Archive();
    const main = await archive.upload(parent, `${PROJECT}/${PARENT}.jsonl`);
    const parentSession = await archive.parse(main);
    // What dev holds today: the subagent's artifact is linked to the parent's
    // session, so a re-parse proposes that session first.
    const one = await archive.upload(first, `${PROJECT}/${PARENT}/subagents/agent-a0f1.jsonl`);
    await archive.store.updateRawArtifact(context, { ...one, sessionIds: [parentSession], status: "parsed" });

    const moved = await archive.parse((await archive.store.getRawArtifact(context, one.sha256))!);

    expect(moved).not.toBe(parentSession);
    expect(await archive.turns(moved)).toBe(turnCount(first));
    expect(await archive.turns(parentSession)).toBe(turnCount(parent));
    expect((await archive.store.getRawArtifact(context, one.sha256))!.sessionIds).toEqual([moved]);
  });

  it("identifies a sidechain with no agent id by its file, never by the parent's id", async () => {
    const archive = new Archive();
    const anonymous = Buffer.from(first.toString("utf8").replaceAll('"agentId":"a0f1",', ""));
    expect(anonymous.toString("utf8")).not.toContain("agentId");
    const main = await archive.upload(parent, `${PROJECT}/${PARENT}.jsonl`);
    const sub = await archive.upload(anonymous, `${PROJECT}/${PARENT}/subagents/agent-old.jsonl`);

    const ids = [await archive.parse(main), await archive.parse(sub)];

    expect(ids[1]).not.toBe(ids[0]);
    expect(await archive.turns(ids[0]!)).toBe(turnCount(parent));
  });

  it("never lets an older capture of a file replace a newer one", async () => {
    // A growing transcript is uploaded again on every append, and the parses
    // run in whatever order the workers take them.
    const archive = new Archive();
    const path = `${PROJECT}/${PARENT}.jsonl`;
    const grown = syntheticClaudeTranscript({ targetBytes: 60_000, sessionId: PARENT, seed: "parent", toolOutputBytes: 400 });
    expect(turnCount(grown)).toBeGreaterThan(turnCount(parent));
    const early = await archive.upload(parent, path, "2026-11-25T12:00:00.000Z");
    const late = await archive.upload(grown, path, "2026-11-25T13:00:00.000Z");

    const session = await archive.parse(late);
    expect(await archive.parse(early), "the stale capture still belongs to the session").toBe(session);

    expect(await archive.turns(session)).toBe(turnCount(grown));
    const stale = (await archive.store.getRawArtifact(context, early.sha256))!;
    expect(stale.status).toBe("parsed");
    expect(stale.diagnostic).toBe(SUPERSEDED_DIAGNOSTIC);

    // Parsed in capture order, the newer one is simply the last write.
    const ordered = new Archive();
    const a = await ordered.upload(parent, path, "2026-11-25T12:00:00.000Z");
    const b = await ordered.upload(grown, path, "2026-11-25T13:00:00.000Z");
    await ordered.parse(a);
    expect(await ordered.turns(await ordered.parse(b))).toBe(turnCount(grown));
    expect((await ordered.store.getRawArtifact(context, b.sha256))!.diagnostic).toBeNull();
  });
});
