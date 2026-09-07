import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { derivedUuid, isUuid, mapParent, turnId } from "../libs/parsers/src/common.js";
import { ClaudeCodeV1Parser } from "../libs/parsers/src/claude-code.js";
import type { ParseRequest } from "../libs/parsers/src/types.js";
import { uuidV5 } from "../src/ids.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";
import type { TenantContext } from "../src/archive-store.js";

const SEED_ID = "0191cafe-0000-7000-8000-0000000000b0";

/**
 * A transcript whose message ids are not uuids.
 *
 * Found the hard way: an artifact sat in a live archive for twenty days,
 * parsed correctly and refused by the database with `invalid input syntax for
 * type uuid`, because the parser handed the transcript's own id straight to a
 * uuid column. Every fixture in this repository uses uuids, so nothing caught
 * it — the fixtures were written by whoever wrote the parsers.
 */
const AWKWARD_IDS = [
  { uuid: "msg_01HQ8X", parentUuid: null, timestamp: "2026-08-18T10:00:00.000Z", message: { role: "user", content: "first" } },
  {
    uuid: "msg_01HQ8Y",
    parentUuid: "msg_01HQ8X",
    timestamp: "2026-08-18T10:00:05.000Z",
    // Blocks that name themselves, and not with uuids either. The live
    // artifact failed twice: once on its turn ids, then on these.
    message: { role: "assistant", content: [{ type: "text", id: "block-1", text: "second" }] },
  },
];

function request(records: unknown[]): ParseRequest {
  return {
    source: "claude-code",
    version: "v1",
    raw: Buffer.from(records.map((record) => JSON.stringify(record)).join("\n")),
    seed: {
      id: SEED_ID,
      source: { vendor: "anthropic", tool: "claude-code", version: "v1", machineId: "0191cafe-0000-7000-8000-0000000000b1", nativeSessionId: "native" },
      workspace: { path: "/workspace" },
      createdAt: "2026-08-18T10:00:00.000Z",
      updatedAt: "2026-08-18T10:00:05.000Z",
      title: "awkward ids",
      models: ["claude-opus-5"],
      tokenTotals: { input: 0, output: 0 },
      provenance: [],
      visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-0000000000b2" },
      turns: [],
    },
  } as unknown as ParseRequest;
}

describe("turn identity when a source does not use uuids", () => {
  it("keeps a native uuid exactly as it is", () => {
    // Nothing already archived may move: a derived id for a turn that already
    // had a good one would orphan every annotation pointing at it.
    const native = "0191cafe-0000-7000-8000-0000000000c1";
    expect(turnId(native, SEED_ID)).toBe(native);
    expect(isUuid(native)).toBe(true);
    expect(isUuid("msg_01HQ8X")).toBe(false);
    expect(isUuid("0191cafe-0000-7000-8000-0000000take0b"), "the id that broke a live archive").toBe(false);
  });

  it("derives a stable uuid for anything else", () => {
    const first = turnId("msg_01HQ8X", SEED_ID);
    expect(isUuid(first), "must be storable in a uuid column").toBe(true);
    // Deterministic, or re-capturing a growing transcript would give the same
    // turn a new id every time and everything pointing at it would break.
    expect(turnId("msg_01HQ8X", SEED_ID)).toBe(first);
    // Scoped to the session, so two sessions that both call a message "1" do
    // not collide.
    expect(turnId("msg_01HQ8X", "0191cafe-0000-7000-8000-0000000000ff")).not.toBe(first);
  });

  it("derives the same uuids the server does", () => {
    // The parsers are a library the server depends on, so this derivation is
    // repeated there rather than imported. This is what keeps the two copies
    // from drifting apart.
    for (const name of ["a", "session:turn:msg_1", "", "ünïcode"]) {
      expect(derivedUuid(name)).toBe(uuidV5(name));
    }
  });

  it("rewrites parent links through the same mapping", () => {
    // A remapped turn pointed at by a parent link that still names the original
    // is a broken thread that looks like a parsing bug months later.
    const parsed = new ClaudeCodeV1Parser().parse(request(AWKWARD_IDS));
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;

    const [first, second] = parsed.sessions[0]!.turns;
    expect(isUuid(first!.id)).toBe(true);
    expect(isUuid(second!.id)).toBe(true);
    expect(second!.parentId, "the reply must point at the turn it replies to").toBe(first!.id);
    expect(first!.parentId).toBeNull();
    expect(mapParent(null, SEED_ID)).toBeNull();
  });

  it("archives a transcript that a uuid column would have refused", async () => {
    // The end of the story the diagnostic told: parsed correctly, never stored.
    const store = new DevArchiveStore();
    const objects = new MemoryObjectStorage();
    const context: TenantContext = {
      tenantId: "0191cafe-0000-7000-8000-0000000000d1",
      userId: "0191cafe-0000-7000-8000-0000000000d2",
      scopes: ["ingest:write"],
      authType: "machine",
      machineId: "0191cafe-0000-7000-8000-0000000000d3",
    };
    const bytes = Buffer.from(AWKWARD_IDS.map((record) => JSON.stringify(record)).join("\n"));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await objects.put(`tenants/${context.tenantId}/raw/${sha256}`, bytes);
    await store.saveRawArtifact(context, {
      id: "0191cafe-0000-7000-8000-0000000000d4",
      tenantId: context.tenantId,
      sessionIds: [],
      sha256,
      size: bytes.byteLength,
      objectKey: `tenants/${context.tenantId}/raw/${sha256}`,
      status: "stored",
      source: "claude-code",
      sourcePath: "/tmp/session.jsonl",
      capturedAt: "2026-08-18T10:00:05.000Z",
      diagnostic: null,
    });

    const outcome = await new IngestPipeline(store, objects).process(context, sha256);

    expect(outcome.status, "the whole session was refused before this").toBe("parsed");
    expect(outcome.sessionIds).toHaveLength(1);
    const session = await store.getSession(context, outcome.sessionIds[0]!);
    expect(session!.turns).toHaveLength(2);
    expect(session!.turns[1]!.parentId).toBe(session!.turns[0]!.id);
    // Blocks land in a uuid column too, and a source that names its own blocks
    // is not thereby allowed to name them anything it likes.
    for (const turn of session!.turns) {
      for (const block of turn.blocks) expect(isUuid(block.id), `block id ${block.id}`).toBe(true);
    }
  });
});
