import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { CollectionService, SharingService } from "../src/curation.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { TeamsService } from "../src/teams.js";

const alice = TEST_CONTEXT;
const bob: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000c1",
  userId: "0191cafe-0000-7000-8000-0000000000c2",
  scopes: ["*"],
  authType: "dev",
};
const mallory: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000c3",
  userId: "0191cafe-0000-7000-8000-0000000000c4",
  scopes: ["*"],
  authType: "dev",
};

function seedAccounts(store: DevArchiveStore): void {
  store.accountsByEmail.set("alice@example.test", { userId: alice.userId, tenantId: alice.tenantId, email: "alice@example.test" });
  store.accountsByEmail.set("bob@example.test", { userId: bob.userId, tenantId: bob.tenantId, email: "bob@example.test" });
}

describe("team scope", () => {
  it("creates a team, invites members by email, and gates every read on accepted membership", async () => {
    const store = new DevArchiveStore();
    seedAccounts(store);
    const teams = new TeamsService(store);

    const team = await teams.create(alice, { name: "platform" });
    const teamId = team.id as string;
    expect(team.memberCount).toBe(1);
    expect((await teams.list(alice)).items).toHaveLength(1);
    expect((await teams.list(bob)).items).toHaveLength(0);

    await expect(teams.invite(bob, teamId, "bob@example.test")).rejects.toThrow("not a member");
    await teams.invite(alice, teamId, "bob@example.test");
    // An invitation on its own changes nothing about what Bob can see.
    expect((await teams.list(bob)).items).toHaveLength(0);
    expect((await teams.listInvitations(bob)).items).toMatchObject([{ teamId, teamName: "platform" }]);
    await teams.acceptInvitation(bob, teamId);
    expect((await teams.list(bob)).items[0]).toMatchObject({ id: teamId, memberCount: 2 });
    await expect(teams.invite(alice, teamId, "nobody@example.test")).rejects.toThrow("No account");

    await expect(teams.listSessions(mallory, teamId)).rejects.toThrow("not a member");
    await teams.removeMember(bob, teamId, bob.userId);
    await expect(teams.listSessions(bob, teamId)).rejects.toThrow("not a member");
  });

  it("shows the sender an invitation they sent, which nothing else does", async () => {
    /*
      The gap this route closes. PUT /teams/:id/members answers 204 and then
      nothing the sender can read changes: memberCount counts accepted members
      only, and GET /teams/invitations is the invitee's own list. Before this,
      an invitation you had just sent was invisible to you.
    */
    const store = new DevArchiveStore();
    seedAccounts(store);
    const teams = new TeamsService(store);

    const team = await teams.create(alice, { name: "platform" });
    const teamId = team.id as string;

    expect((await teams.listMembers(alice, teamId)).items).toEqual([
      { userId: alice.userId, email: "alice@example.test", status: "active" },
    ]);

    await teams.invite(alice, teamId, "bob@example.test");
    // The count has not moved, because Bob has not joined. The roster has.
    expect((await teams.list(alice)).items[0]).toMatchObject({ memberCount: 1 });
    expect((await teams.listMembers(alice, teamId)).items).toContainEqual({
      userId: bob.userId, email: "bob@example.test", status: "invited",
    });

    await teams.acceptInvitation(bob, teamId);
    expect((await teams.listMembers(bob, teamId)).items).toContainEqual({
      userId: bob.userId, email: "bob@example.test", status: "active",
    });
  });

  it("refuses the roster to anybody who is not an accepted member of that team", async () => {
    // Who is on a team is a team read. An outsider must not get it, and neither
    // must somebody who has only been invited: an invitation grants no reads.
    const store = new DevArchiveStore();
    seedAccounts(store);
    const teams = new TeamsService(store);

    const team = await teams.create(alice, { name: "platform" });
    const teamId = team.id as string;
    await teams.invite(alice, teamId, "bob@example.test");

    await expect(teams.listMembers(mallory, teamId)).rejects.toThrow("not a member");
    await expect(teams.listMembers(bob, teamId)).rejects.toThrow("not a member");
  });

  it("serves no tenant id on the roster, because that is the isolation key", async () => {
    const store = new DevArchiveStore();
    seedAccounts(store);
    const teams = new TeamsService(store);

    const team = await teams.create(alice, { name: "platform" });
    await teams.invite(alice, team.id as string, "bob@example.test");

    for (const member of (await teams.listMembers(alice, team.id as string)).items) {
      expect(Object.keys(member).sort()).toEqual(["email", "status", "userId"]);
    }
  });

  it("lists team-widened sessions across member tenants and team-shared collections", async () => {
    const store = new DevArchiveStore();
    seedAccounts(store);
    const teams = new TeamsService(store);
    const sharing = new SharingService(store);
    const collections = new CollectionService(store);

    const team = await teams.create(alice, { name: "platform" });
    const teamId = team.id as string;
    await teams.invite(alice, teamId, "bob@example.test");
    await teams.acceptInvitation(bob, teamId);

    await store.saveSession(alice, TEST_SESSION);
    const bobSession = structuredClone(TEST_SESSION);
    bobSession.id = "0191cafe-0000-7000-8000-0000000000d5";
    bobSession.source = { ...bobSession.source, nativeSessionId: "team-bob-1" };
    bobSession.visibility = { scope: "private", ownerId: bob.userId };
    await store.saveSession(bob, bobSession);

    expect((await teams.listSessions(alice, teamId)).items).toHaveLength(0);

    const aliceReview = await sharing.completeReview(alice, TEST_SESSION.id);
    await sharing.updateVisibility(alice, TEST_SESSION.id, { visibility: { scope: "team", teamId }, redactionReviewId: aliceReview.id });
    const bobReview = await sharing.completeReview(bob, bobSession.id);
    await sharing.updateVisibility(bob, bobSession.id, { visibility: { scope: "team", teamId }, redactionReviewId: bobReview.id });

    const visible = await teams.listSessions(bob, teamId);
    expect(visible.items.map((item) => item.id).sort()).toEqual([TEST_SESSION.id, bobSession.id].sort());

    await expect(collections.create(mallory, { name: "sneaky", teamId })).rejects.toThrow("not a member");
    const shared = await collections.create(alice, { name: "team picks", teamId });
    expect(shared.teamId).toBe(teamId);
    const teamCollections = await teams.listCollections(bob, teamId);
    expect(teamCollections.items).toHaveLength(1);
    expect(teamCollections.items[0]).toMatchObject({ name: "team picks", teamId });
  });
});
