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
  it("creates a team, adds members by email, and gates every read on membership", async () => {
    const store = new DevArchiveStore();
    seedAccounts(store);
    const teams = new TeamsService(store);

    const team = await teams.create(alice, { name: "platform" });
    const teamId = team.id as string;
    expect(team.memberCount).toBe(1);
    expect((await teams.list(alice)).items).toHaveLength(1);
    expect((await teams.list(bob)).items).toHaveLength(0);

    await expect(teams.addMember(bob, teamId, "bob@example.test")).rejects.toThrow("not a member");
    await teams.addMember(alice, teamId, "bob@example.test");
    expect((await teams.list(bob)).items[0]).toMatchObject({ id: teamId, memberCount: 2 });
    await expect(teams.addMember(alice, teamId, "nobody@example.test")).rejects.toThrow("No account");

    await expect(teams.listSessions(mallory, teamId)).rejects.toThrow("not a member");
    await teams.removeMember(bob, teamId, bob.userId);
    await expect(teams.listSessions(bob, teamId)).rejects.toThrow("not a member");
  });

  it("lists team-widened sessions across member tenants and team-shared collections", async () => {
    const store = new DevArchiveStore();
    seedAccounts(store);
    const teams = new TeamsService(store);
    const sharing = new SharingService(store);
    const collections = new CollectionService(store);

    const team = await teams.create(alice, { name: "platform" });
    const teamId = team.id as string;
    await teams.addMember(alice, teamId, "bob@example.test");

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
