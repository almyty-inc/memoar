import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchivedSession, TenantContext } from "../src/archive-store.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { DeterministicEmbeddingProvider, DisabledSemanticSearchProvider, PostgresFtsBackend, PostgresVectorSearchProvider } from "../src/search.js";
import { TeamSearchService } from "../src/search/team-search.js";
import { TEST_SESSION } from "./fixtures/archive.js";
import { dockerAvailable, seedAccount, startPostgres, stopPostgres, TEAM_FANOUT_FIXTURE } from "./helpers/postgres.js";

const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;

function actor(suffix: string): TenantContext {
  return {
    tenantId: `0191cafe-0000-7000-8000-0000000f${suffix}001`,
    userId: `0191cafe-0000-7000-8000-0000000f${suffix}002`,
    scopes: ["*"], authType: "dev",
  };
}

/** Workspace A. */
const alice = actor("a");
const bob = actor("b");
/** Workspace B, with the same-shaped archive, so a leak reads as a collision. */
const mallory = actor("c");

/**
 * The one phrase in every archive. Every session here matches every query, so
 * anything that comes back which should not have is unmistakable, and the id it
 * carries says whose tenant it escaped from.
 */
const PHRASE = "quarterly migration rollback rehearsal";

const ids = {
  aliceShared: "0191cafe-0000-7000-8000-0000000ea001",
  alicePrivate: "0191cafe-0000-7000-8000-0000000ea002",
  bobShared: "0191cafe-0000-7000-8000-0000000eb001",
  bobPrivate: "0191cafe-0000-7000-8000-0000000eb002",
  mallorysShared: "0191cafe-0000-7000-8000-0000000ec001",
};

let owner: DataSource | null = null;
let store: PostgresArchiveStore | null = null;
let teamA = "";
let teamB = "";

function session(id: string, ownerContext: TenantContext, native: string): ArchivedSession {
  const built = structuredClone(TEST_SESSION);
  built.id = id;
  built.source = { ...built.source, nativeSessionId: native };
  built.title = `${PHRASE} ${native}`;
  built.summary = PHRASE;
  built.turns = built.turns.map((turn) => ({
    ...turn,
    blocks: turn.blocks.map((block) => ({ ...block, id: `${id.slice(0, 31)}${block.id.slice(31)}`, text: `${PHRASE} ${native}` })),
  }));
  built.visibility = { scope: "private", ownerId: ownerContext.userId };
  return built;
}

beforeAll(async () => {
  if (!usePostgres) return;
  owner = await startPostgres(TEAM_FANOUT_FIXTURE);
  store = new PostgresArchiveStore(owner);
  const embeddings = new DeterministicEmbeddingProvider(768);
  for (const [who, email] of [[alice, "alice"], [bob, "bob"], [mallory, "mallory"]] as const) {
    await seedAccount(owner, { userId: who.userId, tenantId: who.tenantId, email: `${email}@fanout.test` });
  }
  const a = await store.createTeam({ name: "workspace-a" }, { userId: alice.userId, tenantId: alice.tenantId, email: "alice@fanout.test" });
  teamA = a.id;
  await store.inviteTeamMember(teamA, { userId: bob.userId, tenantId: bob.tenantId, email: "bob@fanout.test" });
  await store.acceptTeamInvitation(teamA, bob.userId);
  const b = await store.createTeam({ name: "workspace-b" }, { userId: mallory.userId, tenantId: mallory.tenantId, email: "mallory@fanout.test" });
  teamB = b.id;

  for (const [id, who, native, team] of [
    [ids.aliceShared, alice, "alice-shared", teamA],
    [ids.alicePrivate, alice, "alice-private", null],
    [ids.bobShared, bob, "bob-shared", teamA],
    [ids.bobPrivate, bob, "bob-private", null],
    [ids.mallorysShared, mallory, "mallory-shared", teamB],
  ] as const) {
    const built = session(id, who, native);
    if (team) built.visibility = { scope: "team", teamId: team, ownerId: who.userId };
    await store.saveSession(who, built);
    // Every session is embedded, so the semantic leg of the fan-out has real
    // pgvector rows to return and the predicate there is exercised too — it is
    // a second SQL string carrying the same clause, and a second place to lose
    // it. All five embed identically, which is the point.
    await store.saveSessionEmbedding(who, id, await embeddings.embed(PHRASE));
  }
}, 240_000);

afterAll(async () => { await stopPostgres(owner, TEAM_FANOUT_FIXTURE); }, 60_000);

/**
 * Why a member of workspace A provably cannot read workspace B, and why a
 * teammate cannot read a member's private sessions.
 *
 * Two separate mechanisms, and this file is the proof of each against a real
 * Postgres with real policies:
 *
 *  - Between workspaces, row-level security does it. Every read pins
 *    `memoar.tenant_id` to exactly one tenant, and the only tenants a team
 *    request may pin are the accepted members' — workspace B's tenants are not
 *    in workspace A's `team_members`, so no SQL in an A request can name one.
 *  - Inside a workspace, row-level security does *not* do it. Once the loop is
 *    in a member's tenant the policy is satisfied for every row that member
 *    owns, private ones included. Only `teamVisibilitySql` stands there.
 */
suite("team fan-out isolation", () => {
  it("never binds another workspace's tenant into a request", async () => {
    const tenants = await store!.listTeamMemberTenants(teamA);
    expect(tenants.sort()).toEqual([alice.tenantId, bob.tenantId].sort());
    expect(tenants).not.toContain(mallory.tenantId);
  });

  it("lists only what members widened to this team", async () => {
    const listed = (await store!.listTeamSessions(teamA)).map((found) => found.id).sort();
    expect(listed).toEqual([ids.aliceShared, ids.bobShared].sort());
  });

  it("refuses a teammate's private session by id, and another workspace's shared one", async () => {
    expect(await store!.getTeamSession(teamA, ids.bobPrivate)).toBeNull();
    expect(await store!.getTeamSession(teamA, ids.alicePrivate)).toBeNull();
    // Team B's session is widened — to team B. Naming it from team A finds
    // nothing, because team A never opens a transaction in Mallory's tenant.
    expect(await store!.getTeamSession(teamA, ids.mallorysShared)).toBeNull();
    expect((await store!.getTeamSession(teamA, ids.bobShared))?.id).toBe(ids.bobShared);
  });

  it("searches both members' archives and returns neither member's private sessions", async () => {
    const search = new TeamSearchService(new PostgresFtsBackend(owner!, store!), new DisabledSemanticSearchProvider());
    const result = await search.execute(teamA, await store!.listTeamMemberTenants(teamA), PHRASE, "lexical", {}, 30);
    const found = result.candidates.map((candidate) => candidate.session.id).sort();

    expect(found).toEqual([ids.aliceShared, ids.bobShared].sort());
    expect(found).not.toContain(ids.bobPrivate);
    expect(found).not.toContain(ids.alicePrivate);
    expect(found).not.toContain(ids.mallorysShared);
  });

  it("keeps the semantic leg inside the same boundary as the lexical one", async () => {
    const semantic = new PostgresVectorSearchProvider(owner!, store!, new DeterministicEmbeddingProvider(768));
    const search = new TeamSearchService(new PostgresFtsBackend(owner!, store!), semantic);
    const result = await search.execute(teamA, await store!.listTeamMemberTenants(teamA), PHRASE, "semantic", {}, 30);

    expect(result.realizedMode).toBe("semantic");
    expect(result.candidates.map((candidate) => candidate.session.id).sort()).toEqual([ids.aliceShared, ids.bobShared].sort());
  });

  it("gives workspace B its own archive and nothing of workspace A's", async () => {
    const search = new TeamSearchService(new PostgresFtsBackend(owner!, store!), new DisabledSemanticSearchProvider());
    const result = await search.execute(teamB, await store!.listTeamMemberTenants(teamB), PHRASE, "lexical", {}, 30);
    expect(result.candidates.map((candidate) => candidate.session.id)).toEqual([ids.mallorysShared]);
  });

  it("finds every one of these sessions when its own tenant does the asking", async () => {
    // The control: the fixture is not passing above because the rows are
    // unsearchable. Each owner can see their own, private ones included.
    const search = new PostgresFtsBackend(owner!, store!);
    const mine = await search.lexical(bob, PHRASE, {}, 30);
    expect(mine.map((candidate) => candidate.session.id).sort()).toEqual([ids.bobPrivate, ids.bobShared].sort());
  });
});

/**
 * The consent table against real Postgres.
 *
 * The in-memory store models this too, and the two have to agree: `NULLS NOT
 * DISTINCT` on the unique constraint, `IS NULL` rather than `= NULL` in the
 * lookups, and the join onto live membership are all Postgres-only details that
 * no memory-store test can reach.
 */
suite("team share opt-ins in Postgres", () => {
  const optin = (machineId: string | null) => ({
    id: `0191cafe-0000-7000-8000-00000000f0${machineId ? "02" : "01"}`,
    teamId: teamA, tenantId: alice.tenantId, userId: alice.userId,
    machineId, createdAt: "2026-09-01T00:00:00.000Z",
  });

  it("records one standing consent per machine and refuses a duplicate", async () => {
    expect(await store!.createTeamOptin(optin(null))).toBe(true);
    // A null machineId means every machine, so there can be only one of them.
    // Under Postgres's default nulls-distinct rule this second insert would
    // succeed and leave two rows that only one revocation could remove.
    expect(await store!.createTeamOptin({ ...optin(null), id: "0191cafe-0000-7000-8000-00000000f0ff" })).toBe(false);
    expect(await store!.listTeamOptins(teamA, alice.tenantId)).toHaveLength(1);
    expect(await store!.listTenantOptins(bob.tenantId)).toEqual([]);
    // And the table itself refuses it, not only the service: two racing
    // enrolments both pass the service's read before either writes.
    await expect(owner!.query(
      `INSERT INTO team_share_optins (id, "teamId", "tenantId", "userId", "machineId") VALUES (gen_random_uuid(), $1, $2, $3, NULL)`,
      [teamA, alice.tenantId, alice.userId],
    )).rejects.toThrow(/team_share_optins_unique/u);
  });

  it("answers ingest with the team, for any machine, and only while the sharer is a member", async () => {
    expect(await store!.resolveIngestTeam(alice.tenantId, "0191cafe-0000-7000-8000-00000000f111")).toBe(teamA);
    expect(await store!.resolveIngestTeam(alice.tenantId)).toBe(teamA);
    expect(await store!.resolveIngestTeam(bob.tenantId)).toBeNull();

    // Leaving the team stops the stamping, even with the consent row still
    // there: a consent that outlived the membership would keep marking captures
    // for a team she is not in, to be revealed all at once if she rejoined.
    await store!.removeTeamMember(teamA, alice.userId);
    expect(await store!.resolveIngestTeam(alice.tenantId)).toBeNull();
    await store!.inviteTeamMember(teamA, { userId: alice.userId, tenantId: alice.tenantId, email: "alice@fanout.test" });
    await store!.acceptTeamInvitation(teamA, alice.userId);
    expect(await store!.resolveIngestTeam(alice.tenantId)).toBe(teamA);
  });

  it("puts the sharer's own sessions back to private when revocation is asked to reach back", async () => {
    // Exactly the one that was widened. Her private session is in the same
    // tenant and the same transaction, and is not revocation's business.
    const reset = await store!.revokeTeamVisibility(alice, teamA, null);
    expect(reset).toBe(1);

    const still = await store!.listTeamSessions(teamA);
    // Alice's are private again; Bob's is untouched, because revocation is a
    // single-tenant write under the revoker's own policy.
    expect(still.map((found) => found.id)).toEqual([ids.bobShared]);
    const mine = await store!.getSession(alice, ids.aliceShared);
    expect(mine?.visibility).toEqual({ scope: "private", ownerId: alice.userId });
  });

  it("removes the consent it was given, and says so when there is none", async () => {
    expect(await store!.deleteTeamOptin(teamA, alice.tenantId, null)).toBe(true);
    expect(await store!.deleteTeamOptin(teamA, alice.tenantId, null)).toBe(false);
    expect(await store!.resolveIngestTeam(alice.tenantId)).toBeNull();
  });
});
