/**
 * The team argument on the reading tools.
 *
 * Absent, every tool behaves exactly as it did. Present, it reads the team's
 * shared archive through the same service the HTTP team routes use — so the
 * membership check and the visibility predicate are the ones already proven,
 * not a second pair written for MCP. The tenant-scoped reads are not loosened:
 * a teammate's session is reachable through the team or not at all.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { ArchivedSession, TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import type { McpToolRegistry } from "../src/mcp/registry.js";
import { buildRegistry } from "./mcp-fixture.js";
import { TEST_SESSION } from "./fixtures/archive.js";

const alice: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-00000000d101",
  userId: "0191cafe-0000-7000-8000-00000000d102",
  scopes: ["*"], authType: "dev",
};
const bob: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-00000000d103",
  userId: "0191cafe-0000-7000-8000-00000000d104",
  scopes: ["*"], authType: "dev",
};
const stranger: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-00000000d105",
  userId: "0191cafe-0000-7000-8000-00000000d106",
  scopes: ["*"], authType: "dev",
};

const PHRASE = "rollback rehearsal";
const SHARED = "0191cafe-0000-7000-8000-00000000d201";
const PRIVATE = "0191cafe-0000-7000-8000-00000000d202";

const store = new DevArchiveStore();
let tools: McpToolRegistry;
let teamId = "";

function session(id: string, native: string): ArchivedSession {
  const built = structuredClone(TEST_SESSION);
  built.id = id;
  built.source = { ...built.source, nativeSessionId: native };
  built.title = `${PHRASE} ${native}`;
  built.summary = PHRASE;
  built.visibility = { scope: "private", ownerId: alice.userId };
  return built;
}

beforeAll(async () => {
  tools = buildRegistry(store);
  const team = await store.createTeam({ name: "platform" }, { userId: alice.userId, tenantId: alice.tenantId, email: "alice@mcp.test" });
  teamId = team.id;
  await store.inviteTeamMember(teamId, { userId: bob.userId, tenantId: bob.tenantId, email: "bob@mcp.test" });
  await store.acceptTeamInvitation(teamId, bob.userId);

  const shared = session(SHARED, "alice-shared");
  shared.visibility = { scope: "team", teamId, ownerId: alice.userId };
  await store.saveSession(alice, shared);
  await store.saveSession(alice, session(PRIVATE, "alice-private"));
});

describe("MCP reads across a team", () => {
  it("searches the team when asked and the caller's own archive when not", async () => {
    const team = await tools.call(bob, "search_sessions", { query: PHRASE, mode: "lexical", teamId });
    expect((team.items as { id: string }[]).map((item) => item.id)).toEqual([SHARED]);

    // Bob's own archive holds none of this. Without the argument the tool is
    // what it has always been, and Alice's sessions are not his to find.
    const own = await tools.call(bob, "search_sessions", { query: PHRASE, mode: "lexical" });
    expect(own.items).toEqual([]);
  });

  it("reads a teammate's shared session and refuses their private one", async () => {
    const chunk = await tools.call(bob, "get_session", { sessionId: SHARED, teamId });
    expect((chunk.session as { id: string }).id).toBe(SHARED);

    await expect(tools.call(bob, "get_session", { sessionId: PRIVATE, teamId })).rejects.toThrow("Session not found");
  });

  it("does not loosen the tenant-scoped read that has always been there", async () => {
    // The same id, without the team: still nothing, because get_session without
    // a team reads one tenant and that session is not in it.
    await expect(tools.call(bob, "get_session", { sessionId: SHARED })).rejects.toThrow("Session not found");
  });

  it("excerpts a teammate's shared session, and nothing else", async () => {
    const excerpt = await tools.call(bob, "get_excerpt", { sessionId: SHARED, turnStart: 0, turnEnd: 1, teamId });
    expect(excerpt.sessionId).toBe(SHARED);
    expect(String(excerpt.excerpt).length).toBeGreaterThan(0);

    await expect(tools.call(bob, "get_excerpt", { sessionId: PRIVATE, turnStart: 0, turnEnd: 1, teamId }))
      .rejects.toThrow("Session not found");
    await expect(tools.call(bob, "get_excerpt", { sessionId: SHARED, turnStart: 0, turnEnd: 1 }))
      .rejects.toThrow("session_not_found");
  });

  it("refuses a team the caller is not in", async () => {
    await expect(tools.call(stranger, "search_sessions", { query: PHRASE, teamId })).rejects.toThrow("not a member");
    await expect(tools.call(stranger, "get_session", { sessionId: SHARED, teamId })).rejects.toThrow("not a member");
  });
});
