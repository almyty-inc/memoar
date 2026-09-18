import { ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { IngestPipeline, MemoryObjectStorage } from "../src/ingest.js";
import { TeamSearchService } from "../src/search/team-search.js";
import { DeterministicLexicalBackend, DisabledSemanticSearchProvider } from "../src/search.js";
import { TeamsService } from "../src/teams.js";
import { TeamWorkspaceService } from "../src/team-workspace.js";

const LAPTOP = "0191cafe-0000-7000-8000-00000000a101";
const DESKTOP = "0191cafe-0000-7000-8000-00000000a102";

const alice: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-00000000a001",
  userId: "0191cafe-0000-7000-8000-00000000a002",
  scopes: ["*"], authType: "dev", machineId: LAPTOP,
};
const bob: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-00000000a003",
  userId: "0191cafe-0000-7000-8000-00000000a004",
  scopes: ["*"], authType: "dev",
};

/** Built at runtime so this repo's own secret scan does not flag the fixture. */
const LIVE_KEY = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");

function transcript(text: string, native: string): Uint8Array {
  const lines = [
    { type: "user", uuid: "11111111-1111-4111-8111-111111111111", parentUuid: null, sessionId: native, cwd: "/work/project", gitBranch: "main", timestamp: "2026-09-09T11:00:00.000Z", message: { role: "user", content: text } },
    { type: "assistant", uuid: "22222222-2222-4222-8222-222222222222", parentUuid: "11111111-1111-4111-8111-111111111111", sessionId: native, timestamp: "2026-09-09T11:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "noted" }] } },
  ];
  return new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"));
}

interface Fixture {
  store: DevArchiveStore;
  teams: TeamsService;
  workspace: TeamWorkspaceService;
  teamId: string;
  capture(context: TenantContext, text: string, native: string): Promise<string>;
}

async function fixture(): Promise<Fixture> {
  const store = new DevArchiveStore();
  store.accountsByEmail.set("bob@example.test", { userId: bob.userId, tenantId: bob.tenantId, email: "bob@example.test" });
  const teams = new TeamsService(store);
  const workspace = new TeamWorkspaceService(
    store,
    teams,
    new TeamSearchService(new DeterministicLexicalBackend(store), new DisabledSemanticSearchProvider()),
  );
  const team = await teams.create(alice, { name: "platform" });
  // Both machines exist and belong to Alice, so ownership checks have something
  // real to pass and to fail against.
  for (const id of [LAPTOP, DESKTOP]) {
    await store.saveMachine(alice, { id, tenantId: alice.tenantId, name: id, platform: "darwin", agentVersion: null, sourceSettings: {}, lastSeenAt: null });
  }
  const objects = new MemoryObjectStorage();
  const pipeline = new IngestPipeline(store, objects);
  const capture = async (context: TenantContext, text: string, native: string): Promise<string> => {
    const bytes = transcript(text, native);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await objects.put(`raw/${sha256}`, bytes);
    await store.saveRawArtifact(context, {
      id: `0191cafe-0000-7000-8000-${sha256.slice(0, 12)}`, tenantId: context.tenantId, sessionIds: [],
      sha256, size: bytes.byteLength, objectKey: `raw/${sha256}`, status: "stored",
      source: "claude-code", sourcePath: `capture/${native}.jsonl`, capturedAt: "2026-09-09T11:00:00.000Z", diagnostic: null,
    });
    const result = await pipeline.process(context, sha256);
    return result.sessionIds[0]!;
  };
  return { store, teams, workspace, teamId: team.id as string, capture };
}

async function scopeOf(fix: Fixture, context: TenantContext, sessionId: string): Promise<string> {
  return (await fix.store.getSession(context, sessionId))!.visibility.scope;
}

describe("standing consent to share into a team", () => {
  it("shares nothing until somebody opts in", async () => {
    const fix = await fixture();
    const sessionId = await fix.capture(alice, "before any enrolment", "s-default-off");
    expect(await scopeOf(fix, alice, sessionId)).toBe("private");
    expect((await fix.teams.listSessions(alice, fix.teamId)).items).toHaveLength(0);
    expect((await fix.workspace.listOptins(alice, fix.teamId)).items).toHaveLength(0);
  });

  it("widens what is captured after the enrolment and leaves what came before it alone", async () => {
    const fix = await fixture();
    const before = await fix.capture(alice, "captured before", "s-before");
    await fix.workspace.enrol(alice, fix.teamId, {});
    const after = await fix.capture(alice, "captured after", "s-after");

    expect(await scopeOf(fix, alice, before)).toBe("private");
    expect(await scopeOf(fix, alice, after)).toBe("team");
    expect((await fix.store.getSession(alice, after))!.visibility.teamId).toBe(fix.teamId);
    // A standing consent to share what I do from now on is not a consent to
    // share everything already on this laptop.
    expect((await fix.teams.listSessions(alice, fix.teamId)).items.map((item) => item.id)).toEqual([after]);
  });

  it("never auto-widens a capture the secret scanner found something in", async () => {
    const fix = await fixture();
    await fix.workspace.enrol(alice, fix.teamId, {});
    const leaky = await fix.capture(alice, `here is the key ${LIVE_KEY} sorry`, "s-findings");
    const session = (await fix.store.getSession(alice, leaky))!;

    expect(session.redactionStatus).toBe("findings");
    // Every other way of widening past private demands a completed human
    // review. Automatic stamping cannot ask a human, so it does not widen.
    expect(session.visibility.scope).toBe("private");
    expect((await fix.teams.listSessions(alice, fix.teamId)).items).toHaveLength(0);
  });

  it("enrols one machine without enrolling the others", async () => {
    const fix = await fixture();
    await fix.workspace.enrol(alice, fix.teamId, { machineId: LAPTOP });
    const shared = await fix.capture({ ...alice, machineId: LAPTOP }, "from the laptop", "s-laptop");
    const kept = await fix.capture({ ...alice, machineId: DESKTOP }, "from the desktop", "s-desktop");

    expect(await scopeOf(fix, alice, shared)).toBe("team");
    expect(await scopeOf(fix, alice, kept)).toBe("private");
  });

  it("refuses to enrol into a team the caller is not in, or a machine that is not theirs", async () => {
    const fix = await fixture();
    await expect(fix.workspace.enrol(bob, fix.teamId, {})).rejects.toThrow("not a member");
    await expect(fix.workspace.enrol(alice, fix.teamId, { machineId: "0191cafe-0000-7000-8000-00000000dead" }))
      .rejects.toThrow("No machine of this account");
  });

  it("refuses a second team, because a session has one teamId to give", async () => {
    const fix = await fixture();
    const other = await fix.teams.create(alice, { name: "infra" });
    await fix.workspace.enrol(alice, fix.teamId, {});
    const refused: unknown = await fix.workspace.enrol(alice, other.id as string, {}).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toMatchObject({ code: "team_optin_conflict", teamId: fix.teamId });
    // And enrolling again where it already is in force is the same enrolment.
    const again = await fix.workspace.enrol(alice, fix.teamId, {});
    expect(again.teamId).toBe(fix.teamId);
    expect((await fix.workspace.listOptins(alice, fix.teamId)).items).toHaveLength(1);
  });

  it("stops sharing at revocation, and only reaches back when asked to", async () => {
    const fix = await fixture();
    await fix.workspace.enrol(alice, fix.teamId, {});
    const shared = await fix.capture(alice, "shared while enrolled", "s-shared");
    expect(await scopeOf(fix, alice, shared)).toBe("team");

    const plain = await fix.workspace.revoke(alice, fix.teamId, "all", false);
    expect(plain.revokedSessions).toBe(0);
    const later = await fix.capture(alice, "captured after leaving", "s-later");
    expect(await scopeOf(fix, alice, later)).toBe("private");
    // Matching every other share here: withdrawing consent stops the next one,
    // it does not unsay the ones already said.
    expect(await scopeOf(fix, alice, shared)).toBe("team");

    await fix.workspace.enrol(alice, fix.teamId, {});
    const retroactive = await fix.workspace.revoke(alice, fix.teamId, "all", true);
    expect(retroactive.revokedSessions).toBe(1);
    expect(await scopeOf(fix, alice, shared)).toBe("private");
    expect((await fix.teams.listSessions(alice, fix.teamId)).items).toHaveLength(0);
  });

  it("refuses a machine path segment that is neither a uuid nor every machine", async () => {
    const fix = await fixture();
    await fix.workspace.enrol(alice, fix.teamId, {});
    await expect(fix.workspace.revoke(alice, fix.teamId, "everything", false)).rejects.toThrow(/must be a uuid/u);
  });

  it("stops stamping the moment the sharer is no longer a member", async () => {
    const fix = await fixture();
    await fix.workspace.enrol(alice, fix.teamId, {});
    expect(await scopeOf(fix, alice, await fix.capture(alice, "while in the team", "s-member"))).toBe("team");

    await fix.teams.removeMember(alice, fix.teamId, alice.userId);
    // A consent row outliving the membership would keep stamping captures for a
    // team she has left — unreadable while she is out, and revealed all at once
    // the day she rejoined.
    expect(await scopeOf(fix, alice, await fix.capture(alice, "after leaving", "s-left"))).toBe("private");
  });
});
