import { describe, expect, it } from "vitest";
import type { ArchivedSession, TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { DeterministicLexicalBackend, DisabledSemanticSearchProvider } from "../src/search.js";
import { MAX_TEAM_SEARCH_TENANTS, TeamSearchService } from "../src/search/team-search.js";
import { TeamsService } from "../src/teams.js";
import { TeamWorkspaceService } from "../src/team-workspace.js";
import { TEST_SESSION } from "./fixtures/archive.js";

const alice: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-00000000b001",
  userId: "0191cafe-0000-7000-8000-00000000b002",
  scopes: ["*"], authType: "dev",
};
const bob: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-00000000b003",
  userId: "0191cafe-0000-7000-8000-00000000b004",
  scopes: ["*"], authType: "dev",
};
/** Invited and never accepted. Nothing of hers may be reachable through the team. */
const carol: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-00000000b005",
  userId: "0191cafe-0000-7000-8000-00000000b006",
  scopes: ["*"], authType: "dev",
};

/**
 * The same sentence in every archive, so a leak reads as a collision rather
 * than as a plausible result. If a private session ever surfaces, the id it
 * carries says whose it was.
 */
const SHARED_PHRASE = "quarterly migration rollback rehearsal";

function session(id: string, owner: TenantContext, native: string): ArchivedSession {
  const built = structuredClone(TEST_SESSION);
  built.id = id;
  built.source = { ...built.source, nativeSessionId: native };
  built.title = `${SHARED_PHRASE} ${native}`;
  built.summary = SHARED_PHRASE;
  built.visibility = { scope: "private", ownerId: owner.userId };
  return built;
}

interface Fixture {
  store: DevArchiveStore;
  teams: TeamsService;
  workspace: TeamWorkspaceService;
  teamId: string;
  ids: Record<"aliceShared" | "alicePrivate" | "bobShared" | "bobPrivate" | "carolPrivate", string>;
}

async function fixture(): Promise<Fixture> {
  const store = new DevArchiveStore();
  for (const [email, who] of [["bob@example.test", bob], ["carol@example.test", carol]] as const) {
    store.accountsByEmail.set(email, { userId: who.userId, tenantId: who.tenantId, email });
  }
  const teams = new TeamsService(store);
  const workspace = new TeamWorkspaceService(
    store,
    teams,
    new TeamSearchService(new DeterministicLexicalBackend(store), new DisabledSemanticSearchProvider()),
  );
  const team = await teams.create(alice, { name: "platform" });
  const teamId = team.id as string;
  await teams.invite(alice, teamId, "bob@example.test");
  await teams.acceptInvitation(bob, teamId);
  await teams.invite(alice, teamId, "carol@example.test");

  const ids = {
    aliceShared: "0191cafe-0000-7000-8000-00000000c001",
    alicePrivate: "0191cafe-0000-7000-8000-00000000c002",
    bobShared: "0191cafe-0000-7000-8000-00000000c003",
    bobPrivate: "0191cafe-0000-7000-8000-00000000c004",
    carolPrivate: "0191cafe-0000-7000-8000-00000000c005",
  };
  for (const [id, owner, native, shared] of [
    [ids.aliceShared, alice, "alice-shared", true],
    [ids.alicePrivate, alice, "alice-private", false],
    [ids.bobShared, bob, "bob-shared", true],
    [ids.bobPrivate, bob, "bob-private", false],
    [ids.carolPrivate, carol, "carol-private", false],
  ] as const) {
    const built = session(id, owner, native);
    if (shared) built.visibility = { scope: "team", teamId, ownerId: owner.userId };
    await store.saveSession(owner, built);
  }
  return { store, teams, workspace, teamId, ids };
}

describe("reading a team across its members", () => {
  it("lists only what members widened, never their private sessions", async () => {
    const fix = await fixture();
    const listed = (await fix.teams.listSessions(bob, fix.teamId)).items.map((item) => item.id).sort();
    expect(listed).toEqual([fix.ids.aliceShared, fix.ids.bobShared].sort());
  });

  it("searches every member's archive and returns nothing private from any of them", async () => {
    const fix = await fixture();
    const response = await fix.workspace.searchTeam(bob, fix.teamId, SHARED_PHRASE, "lexical");
    const items = response.items as { id: string }[];

    // Every session in this fixture matches the query, in three archives. Only
    // the two widened ones are allowed out: inside the fan-out, row-level
    // security is satisfied for every row of the tenant being searched, so the
    // team predicate is the whole of the filtering.
    expect(items.map((item) => item.id).sort()).toEqual([fix.ids.aliceShared, fix.ids.bobShared].sort());
    expect(items.map((item) => item.id)).not.toContain(fix.ids.alicePrivate);
    expect(items.map((item) => item.id)).not.toContain(fix.ids.bobPrivate);
  });

  it("reads one teammate's shared session and refuses their private one", async () => {
    const fix = await fixture();
    const read = await fix.workspace.getSession(bob, fix.teamId, fix.ids.aliceShared);
    expect((read.session as { id: string }).id).toBe(fix.ids.aliceShared);
    expect(read.turns).toHaveLength(TEST_SESSION.turns.length);

    // Knowing the id is not permission to read it, and a session somebody may
    // not see and one that is not there answer the same way.
    await expect(fix.workspace.getSession(bob, fix.teamId, fix.ids.alicePrivate)).rejects.toThrow("Session not found");
  });

  it("leaves an invited member who has not accepted entirely outside the team", async () => {
    const fix = await fixture();
    // Not a reader: she cannot ask the team anything.
    await expect(fix.teams.listSessions(carol, fix.teamId)).rejects.toThrow("not a member");
    await expect(fix.workspace.searchTeam(carol, fix.teamId, SHARED_PHRASE)).rejects.toThrow("not a member");
    // And not a subject: her tenant is never one the team's reads iterate over,
    // so default-on sharing could not reach an account that never agreed.
    expect(await fix.store.listTeamMemberTenants(fix.teamId)).not.toContain(carol.tenantId);
    await expect(fix.workspace.getSession(bob, fix.teamId, fix.ids.carolPrivate)).rejects.toThrow("Session not found");
  });

  it("refuses to fan out over more member tenants than it is willing to", async () => {
    const search = new TeamSearchService(new DeterministicLexicalBackend(new DevArchiveStore()), new DisabledSemanticSearchProvider());
    const tooMany = Array.from({ length: MAX_TEAM_SEARCH_TENANTS + 1 }, (_, index) => `tenant-${index}`);
    await expect(search.execute("team", tooMany, "anything", "hybrid", {}, 10))
      .rejects.toThrow(/at most 25 member tenants/u);
  });

  it("reports one ranking regime for the whole request when a member's semantic leg fails", async () => {
    const fix = await fixture();
    // The semantic provider is disabled here, so every leg's semantic half
    // fails. A per-tenant fallback would rank some members hybrid and others
    // lexical and present the mixture as one list.
    const response = await fix.workspace.searchTeam(bob, fix.teamId, SHARED_PHRASE, "hybrid");
    const meta = response.meta as { requestedMode: string; realizedMode: string; semanticFailure: string | null };
    expect(meta.requestedMode).toBe("hybrid");
    expect(meta.realizedMode).toBe("lexical");
    expect(meta.semanticFailure).toBe("semantic_provider_unavailable");
  });
});
