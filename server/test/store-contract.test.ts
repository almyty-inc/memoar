import { defaultDistillationSettings } from "../src/store/records.js";
import { createHash } from "node:crypto";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchiveStore, RawArtifactRecord, TenantContext } from "../src/archive-store.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { PostgresArchiveStore } from "../src/postgres-archive-store.js";
import { sessionContentDigest } from "../src/store/review-digest.js";
import { dockerAvailable, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

const alice: TenantContext = TEST_CONTEXT;
const bob: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000b1",
  userId: "0191cafe-0000-7000-8000-0000000000b2",
  scopes: ["*"],
  authType: "dev",
};

const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
let dataSource: DataSource | null = null;

beforeAll(async () => {
  if (usePostgres) {
    dataSource = await startPostgres();
    await seedAccount(dataSource, { userId: alice.userId, tenantId: alice.tenantId, email: "alice@example.test" });
    await seedAccount(dataSource, { userId: bob.userId, tenantId: bob.tenantId, email: "bob@example.test" });
  }
}, 180_000);

afterAll(async () => { await stopPostgres(dataSource); });

function artifact(sha: string, sessionIds: string[], tenantId = alice.tenantId): RawArtifactRecord {
  return {
    id: `0191cafe-0000-7000-8000-0000000${sha.slice(0, 5)}`, tenantId, sessionIds, sha256: sha, size: 42,
    objectKey: `raw/${sha}`, status: "parsed", source: "claude-code", sourcePath: "contract/a.jsonl",
    capturedAt: "2026-08-01T00:00:00.000Z", diagnostic: null,
  };
}

/**
 * One behavioral contract, both implementations. The memory store is what unit
 * tests run against; the Postgres store is what production runs. Divergence
 * between them is exactly the class of bug that only showed up live before.
 */
const implementations: { name: string; skip: boolean; create: () => ArchiveStore }[] = [
  { name: "memory", skip: false, create: () => new DevArchiveStore() },
  { name: "postgres", skip: !usePostgres, create: () => new PostgresArchiveStore(dataSource!) },
];

for (const implementation of implementations) {
  const suite = implementation.skip ? describe.skip : describe;

  suite(`ArchiveStore contract: ${implementation.name}`, () => {
    /** One reading of CLAUDE.md on one machine. */
    function capture(text: string, overrides: Record<string, unknown> = {}) {
      return {
        scope: "project" as const,
        machineId: "0191cafe-0000-7000-8000-0000000000c9",
        workspacePath: "/workspace/memoar",
        path: "/workspace/memoar/CLAUDE.md",
        title: "CLAUDE.md",
        readers: ["claude-code", "zed", "copilot"],
        contentHash: createHash("sha256").update(text).digest("hex"),
        text,
        capturedAt: "2026-08-20T00:00:00.000Z",
        visibility: { scope: "private" as const, ownerId: alice.userId },
        redactionStatus: "clear" as const,
        redactionFindings: [] as string[],
        ...overrides,
      };
    }

    it("keeps one memory document per file and a revision per change", async () => {
      // The agent re-reads these files on a timer, so most captures find them
      // exactly as they were: an unchanged read must add nothing. What did
      // change is the whole point — how a project's instructions evolved is
      // what overwriting destroys.
      const store = implementation.create();
      const first = await store.captureMemoryDocument(alice, capture("Be terse."));
      const again = await store.captureMemoryDocument(alice, capture("Be terse."));
      const edited = await store.captureMemoryDocument(alice, capture("Be terse. Never guess."));

      expect(again.document.id, "the same file is the same document").toBe(first.document.id);
      expect(again.revision, "an unchanged file adds no history").toBeNull();
      expect(edited.revision, "an edited one does").not.toBeNull();
      expect(edited.document.contentHash).toBe(edited.revision!.contentHash);

      const revisions = await store.listMemoryRevisions(alice, first.document.id);
      expect(revisions.map((revision) => revision.text), "newest first").toEqual(["Be terse. Never guess.", "Be terse."]);
      expect(revisions[0]!.size).toBe(Buffer.byteLength("Be terse. Never guess.", "utf8"));

      // Reverting an edit returns to text already recorded, which is the same
      // revision rather than a third one.
      const reverted = await store.captureMemoryDocument(alice, capture("Be terse."));
      expect(reverted.revision!.id).toBe(revisions[1]!.id);
      expect(await store.listMemoryRevisions(alice, first.document.id)).toHaveLength(2);
    });

    it("keeps one tenant's memory out of another's, and out of another machine's", async () => {
      const store = implementation.create();
      const mine = await store.captureMemoryDocument(alice, capture("Alice project rules."));
      await store.captureMemoryDocument(bob, capture("Bob project rules."));

      expect(await store.getMemoryDocument(bob, mine.document.id)).toBeNull();
      expect(await store.listMemoryRevisions(bob, mine.document.id)).toEqual([]);
      const bobsDocuments = await store.listMemoryDocuments(bob);
      expect(bobsDocuments.map((document) => document.id)).not.toContain(mine.document.id);

      // The same path on a second machine is a different file, because it is.
      const elsewhere = await store.captureMemoryDocument(alice, capture("Other laptop.", { machineId: "0191cafe-0000-7000-8000-0000000000ca" }));
      expect(elsewhere.document.id).not.toBe(mine.document.id);
      expect(await store.listMemoryDocuments(alice, { machineId: "0191cafe-0000-7000-8000-0000000000ca" }))
        .toHaveLength(1);
    });

    /*
      Both implementations must agree about when a memory file counts as
      reviewed, because the gate that keeps a credential inside the tenant is
      built on it. The in-memory store is what the unit tests run against; the
      Postgres store is what production runs, and it does this in a WHERE clause
      rather than in JavaScript.
    */
    it("marks a memory document reviewed, for the version that was reviewed", async () => {
      const store = implementation.create();
      const captured = await store.captureMemoryDocument(alice, capture("The key is sk_live_0123456789abcdefghij.", {
        redactionStatus: "findings", redactionFindings: ["api_key"],
      }));
      const { id, contentHash } = captured.document;

      expect(await store.reviewMemoryDocument(alice, id, "b".repeat(64)), "a stale hash reviews nothing").toBeNull();
      expect(await store.reviewMemoryDocument(bob, id, contentHash), "and neither does another tenant").toBeNull();
      expect((await store.getMemoryDocument(alice, id))!.redactionStatus).toBe("findings");

      const reviewed = await store.reviewMemoryDocument(alice, id, contentHash);
      expect(reviewed!.redactionStatus).toBe("reviewed");
      expect(reviewed!.redactionFindings, "what was found does not stop being true once it is reviewed").toEqual(["api_key"]);

      // The agent re-reads on a timer: an unchanged reading must not undo it.
      const again = await store.captureMemoryDocument(alice, capture("The key is sk_live_0123456789abcdefghij.", {
        redactionStatus: "findings", redactionFindings: ["api_key"],
      }));
      expect(again.document.redactionStatus).toBe("reviewed");

      const edited = await store.captureMemoryDocument(alice, capture("The key is sk_live_zyxwvutsrqponmlkjihg.", {
        redactionStatus: "findings", redactionFindings: ["api_key"],
      }));
      expect(edited.document.redactionStatus, "nobody has read this version").toBe("findings");
    });

    it("removes a document with everything it ever said", async () => {
      const store = implementation.create();
      const document = (await store.captureMemoryDocument(alice, capture("Draft."))).document;
      await store.captureMemoryDocument(alice, capture("Revised."));

      expect(await store.deleteMemoryDocument(alice, document.id)).toBe(true);
      expect(await store.getMemoryDocument(alice, document.id)).toBeNull();
      expect(await store.listMemoryRevisions(alice, document.id), "revisions must not outlive the file").toEqual([]);
      expect(await store.deleteMemoryDocument(alice, document.id)).toBe(false);
    });

    it("round-trips a canonical session and isolates tenants", async () => {
      const store = implementation.create();
      const session = structuredClone(TEST_SESSION);
      session.id = "0191cafe-0000-7000-8000-0000000c0001";
      await store.saveSession(alice, session);

      const loaded = await store.getSession(alice, session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe(session.title);
      expect(loaded!.turns).toHaveLength(session.turns.length);
      expect(loaded!.turns[0]!.blocks[0]!.text).toBe(session.turns[0]!.blocks[0]!.text);
      expect(loaded!.turns[1]!.parentId).toBe(session.turns[1]!.parentId);

      // The cheap existence check has to answer exactly what the read answers.
      // A query that forgets the tenant filter turns "does this exist" into an
      // oracle for another tenant's session ids.
      expect(await store.sessionExists(alice, session.id)).toBe(true);
      expect(await store.sessionExists(bob, session.id)).toBe(false);
      expect(await store.sessionExists(alice, "0191cafe-0000-7000-8000-00000000dead")).toBe(false);

      expect(await store.getSession(bob, session.id)).toBeNull();
      expect((await store.listSessions(bob, { limit: 10 })).items).toHaveLength(0);
    });

    it("resolves a stable canonical id for the same native identity", async () => {
      const store = implementation.create();
      const identity = { sourceTool: "claude-code", sourceVersion: "v1", nativeSessionId: `native-${implementation.name}` };
      const first = await store.resolveSessionIdentity(alice, identity, "0191cafe-0000-7000-8000-0000000c0002");
      const second = await store.resolveSessionIdentity(alice, identity, "0191cafe-0000-7000-8000-0000000c0003");
      expect(second).toBe(first);
    });

    it("updates visibility without rewriting turns", async () => {
      const store = implementation.create();
      const session = structuredClone(TEST_SESSION);
      session.id = "0191cafe-0000-7000-8000-0000000c0004";
      await store.saveSession(alice, session);

      expect(await store.updateSessionVisibility(alice, session.id, { scope: "team", ownerId: alice.userId, teamId: bob.tenantId })).toBe(true);
      const loaded = await store.getSession(alice, session.id);
      expect(loaded!.visibility).toMatchObject({ scope: "team", teamId: bob.tenantId });
      expect(loaded!.turns).toHaveLength(session.turns.length);
      expect(await store.updateSessionVisibility(alice, "0191cafe-0000-7000-8000-00000000dead", { scope: "private", ownerId: alice.userId })).toBe(false);
    });

    it("stores artifacts with their session joins and reports duplicates", async () => {
      const store = implementation.create();
      const session = structuredClone(TEST_SESSION);
      session.id = "0191cafe-0000-7000-8000-0000000c0005";
      await store.saveSession(alice, session);
      const sha = "c".repeat(64);

      expect(await store.saveRawArtifact(alice, artifact(sha, []))).toBe(true);
      expect(await store.saveRawArtifact(alice, artifact(sha, []))).toBe(false);
      await store.updateRawArtifact(alice, { ...artifact(sha, [session.id]), status: "parsed" });

      const loaded = await store.getRawArtifact(alice, sha);
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionIds).toEqual([session.id]);
      expect(loaded!.size).toBe(42);
      expect(await store.listArtifactHashes(alice, [sha, "d".repeat(64)])).toEqual(new Set([sha]));
      expect(await store.getRawArtifact(bob, sha)).toBeNull();
    });

    it("keeps tenant settings and the distillation budget consistent", async () => {
      const store = implementation.create();
      expect((await store.getTenantSettings(alice)).retention.policy).toBe("indefinite");
      await store.saveTenantSettings(alice, {
        redaction: { secretScan: true, pathScan: true, emailScan: false, customPatterns: ["ACME_[A-Z]{4}"] },
        retention: { policy: "days", days: 30, exemptCollected: true },
        updatedAt: new Date().toISOString(),
      });
      const settings = await store.getTenantSettings(alice);
      expect(settings.retention).toMatchObject({ policy: "days", days: 30 });
      expect(settings.redaction.customPatterns).toEqual(["ACME_[A-Z]{4}"]);

      await store.saveDistillationSettings(alice, {
        ...defaultDistillationSettings(),
        enabled: true, monthlyBudgetCents: 100, monthlySpentCents: 0, budgetWindowStartedAt: new Date().toISOString(),
      });
      expect(await store.reserveDistillationBudget(alice, 60)).toMatchObject({ reserved: true });
      expect(await store.reserveDistillationBudget(alice, 60)).toMatchObject({ reserved: false });
      await store.settleDistillationSpend(alice, -60);
      expect((await store.getDistillationSettings(alice)).monthlySpentCents).toBe(0);

      // Reset so the retention sweep case below controls its own policy.
      await store.saveTenantSettings(alice, {
        redaction: { secretScan: true, pathScan: false, emailScan: false, customPatterns: [] },
        retention: { policy: "indefinite", exemptCollected: true },
        updatedAt: null,
      });
    });

    /*
      Both stores must answer the same budget, because this number is what the
      distiller turns into `maxTokens: min(4000, remainingCents * 400)`. Postgres
      reads it back off the row it just charged; the memory store used to report
      the budget as it stood *before* the reservation, so every test ran against
      a wider ceiling than production ever had.
    */
    it("reports the budget left after the reservation, not before it", async () => {
      const store = implementation.create();
      await store.saveDistillationSettings(alice, {
        ...defaultDistillationSettings(),
        enabled: true, monthlyBudgetCents: 100, monthlySpentCents: 0, budgetWindowStartedAt: new Date().toISOString(),
      });

      expect(await store.reserveDistillationBudget(alice, 30)).toEqual({ reserved: true, remainingCents: 70 });
      expect(await store.reserveDistillationBudget(alice, 30)).toEqual({ reserved: true, remainingCents: 40 });
      // A refusal charges nothing, so it reports what is still there.
      expect(await store.reserveDistillationBudget(alice, 50)).toEqual({ reserved: false, remainingCents: 40 });
    });

    /*
      Retention deletes what retention covers, and nothing else.

      `artifact_sessions` has no foreign key to `sessions`, and deleting a
      session by hand leaves the join row behind. The Postgres sweep used to
      remove any artifact whose joins all failed to resolve to a live session,
      which is also true of an artifact one day old whose session someone just
      deleted — so a 365-day policy destroyed it and counted it as retention's
      doing. The bytes are kept deliberately, for a parser written later.
    */
    it("removes only the artifacts whose every session this sweep took", async () => {
      const store = implementation.create();
      const handDeleted = structuredClone(TEST_SESSION);
      handDeleted.id = "0191cafe-0000-7000-8000-0000000c0011";
      const stale = structuredClone(TEST_SESSION);
      stale.id = "0191cafe-0000-7000-8000-0000000c0012";
      stale.updatedAt = "2020-01-01T00:00:00.000Z";
      const kept = structuredClone(TEST_SESSION);
      kept.id = "0191cafe-0000-7000-8000-0000000c0013";
      for (const session of [handDeleted, stale, kept]) await store.saveSession(alice, session);

      const orphaned = "e".repeat(64);
      const covered = "f".repeat(64);
      const shared = "a".repeat(64);
      for (const [sha, sessionIds] of [
        [orphaned, [handDeleted.id]], [covered, [stale.id]], [shared, [stale.id, kept.id]],
      ] as [string, string[]][]) {
        await store.saveRawArtifact(alice, artifact(sha, []));
        await store.updateRawArtifact(alice, artifact(sha, sessionIds));
      }
      // Somebody removes one session by hand. It is a day old; retention is
      // nowhere near it.
      expect(await store.deleteSession(alice, handDeleted.id)).toBe(true);

      const result = await store.applyRetention(alice, "2021-01-01T00:00:00.000Z", true);
      expect(result.deletedSessions).toBe(1);
      expect(result.deletedArtifacts, "only the artifact whose only session aged out").toBe(1);

      expect(await store.getRawArtifact(alice, covered)).toBeNull();
      expect(
        await store.getRawArtifact(alice, orphaned),
        "a hand-deleted session does not make its artifact retention's to destroy",
      ).not.toBeNull();
      const survivor = await store.getRawArtifact(alice, shared);
      expect(survivor, "an artifact with a session left is an artifact with bytes left").not.toBeNull();
      expect(survivor!.sessionIds, "the aged-out half of the join goes with it").toEqual([kept.id]);
    });

    it("enumerates tenants and applies retention with the collected exemption", async () => {
      const store = implementation.create();
      const stale = structuredClone(TEST_SESSION);
      stale.id = "0191cafe-0000-7000-8000-0000000c0006";
      stale.updatedAt = "2020-01-01T00:00:00.000Z";
      const staleCollected = structuredClone(TEST_SESSION);
      staleCollected.id = "0191cafe-0000-7000-8000-0000000c0007";
      staleCollected.updatedAt = "2020-01-01T00:00:00.000Z";
      await store.saveSession(alice, stale);
      await store.saveSession(alice, staleCollected);
      await store.saveCollection(alice, {
        id: "0191cafe-0000-7000-8000-0000000c0008", tenantId: alice.tenantId,
        name: "keep", sessionIds: [staleCollected.id], updatedAt: new Date().toISOString(),
      });

      expect(await store.listTenantIds()).toContain(alice.tenantId);
      const result = await store.applyRetention(alice, "2021-01-01T00:00:00.000Z", true);
      expect(result.deletedSessions).toBe(1);
      expect(await store.getSession(alice, stale.id)).toBeNull();
      expect(await store.getSession(alice, staleCollected.id)).not.toBeNull();
    });

    it("creates teams, resolves accounts by email, and lists team-visible sessions across tenants", async () => {
      const store = implementation.create();
      if (implementation.name === "memory") {
        (store as DevArchiveStore).accountsByEmail.set("bob@example.test", { userId: bob.userId, tenantId: bob.tenantId, email: "bob@example.test" });
      }
      const team = await store.createTeam({ name: `contract-${implementation.name}` }, { userId: alice.userId, tenantId: alice.tenantId, email: "alice@example.test" });
      expect(team.memberCount).toBe(1);
      expect(await store.isTeamMember(team.id, alice.userId)).toBe(true);
      expect(await store.isTeamMember(team.id, bob.userId)).toBe(false);

      const account = await store.findAccountByEmail("bob@example.test");
      expect(account).toMatchObject({ userId: bob.userId, tenantId: bob.tenantId });
      await store.inviteTeamMember(team.id, account!);
      // An invitation is not a membership: it grants no reads until taken up.
      expect(await store.isTeamMember(team.id, bob.userId)).toBe(false);
      expect((await store.listTeamInvitations(bob.userId)).map((invitation) => invitation.teamId)).toContain(team.id);
      // The roster carries both halves and says which is which, so the account
      // that sent the invitation has somewhere to see it before it is accepted.
      expect(await store.listTeamMembers(team.id)).toEqual([
        { userId: alice.userId, email: "alice@example.test", status: "active" },
        { userId: bob.userId, email: "bob@example.test", status: "invited" },
      ]);
      expect(await store.acceptTeamInvitation(team.id, bob.userId)).toBe(true);
      expect(await store.isTeamMember(team.id, bob.userId)).toBe(true);
      expect(await store.listTeamMembers(team.id)).toContainEqual({ userId: bob.userId, email: "bob@example.test", status: "active" });

      const bobSession = structuredClone(TEST_SESSION);
      bobSession.id = "0191cafe-0000-7000-8000-0000000c0009";
      bobSession.visibility = { scope: "team", ownerId: bob.userId, teamId: team.id };
      await store.saveSession(bob, bobSession);
      const visible = await store.listTeamSessions(team.id);
      expect(visible.map((session) => session.id)).toContain(bobSession.id);

      expect(await store.removeTeamMember(team.id, bob.userId)).toBe(true);
      expect(await store.removeTeamMember(team.id, bob.userId)).toBe(false);
    });

    /*
      `getMachine` is an authorization check, not just a read: capturing a
      memory file and queuing a materialize command both resolve the machine id
      they were handed and refuse what does not come back. A store that answered
      by id alone would hand one account another account's machine and turn both
      checks into no-ops, so the scoping is pinned here, where both stores are
      held to it rather than only the one the service tests happen to run on.
    */
    /*
      The reason beside the count is the commonest one, not an arbitrary one.

      This is the single line a person reads to learn why their capture is not
      being read, and all three implementations of it disagreed: Postgres took
      `max(diagnostic)`, which sorts alphabetically and has nothing to do with
      how often a reason occurs, and the memory store took whichever row it
      happened to read last. On the real archive that meant a five-row "session
      persistence failed" was reported over the twelve-hundred-row "no parser
      for claude-code@unknown" — the signal fired correctly and named the wrong
      cause, sending the reader after a database bug instead of a capture
      pattern collecting the wrong files.
    */
    /*
      A transcript that leaked a credential on thousands of lines.

      The scanner writes one annotation per finding, and the store wrote them
      as a single statement "whatever the count". Two ceilings sat under that:
      Postgres refuses more than 65535 bind parameters in one statement, which
      these seven-column rows hit at about nine thousand, and below that
      TypeORM builds the statement by spreading the parameter array, which
      throws `Maximum call stack size exceeded` — not a depth problem, and not
      something a bigger stack fixes.

      It did not fail as "could not save the findings". It failed the whole
      parse: seven artifacts, 470 MB of real transcripts, recorded as
      `parse failed: Maximum call stack size exceeded`, losing the session, its
      turns and its blocks over the annotation write that came after them.

      10_000 is deliberately past the parameter ceiling, so a store that writes
      them in one statement cannot pass this by being lucky.
    */
    /*
      A transcript that recorded a NUL.

      Postgres will not store U+0000 in a text column or in jsonb, and the
      refusal — `unsupported Unicode escape sequence` — fails the statement, so
      it failed the save. Three real transcripts, 253 MB between them, died
      exactly there after clearing every other fix on this branch. A tool that
      prints a binary file puts a NUL in its output, and the transcript records
      the output faithfully, so one stray byte in one tool result lost every
      turn in the session.

      The NUL goes into block text and into jsonb data both, because those are
      two different columns and a fix that cleaned one would pass a test that
      only tried it.
    */
    /*
      Two sessions that share a native turn id.

      `turnId` passes a native uuid through unchanged, so when Claude Desktop's
      audit.jsonl and its -outputs/*.jsonl reuse a record uuid, two different
      sessions carry the same turn id. Blocks were unique on (tenant, turn,
      ordinal) with no session in the key, so the second session's blocks
      collided with the first's and the whole save failed — 16 artifacts,
      197 MB, on the dev archive.

      Both sessions must survive, each with its own blocks.
    */
    it("keeps two sessions that share a turn id, each with its own blocks", async () => {
      const store = implementation.create();
      const shared = "0191cafe-0000-7000-8000-0000000c0b01";
      const sessionWith = (sessionId: string, blockId: string, text: string) => {
        const session = structuredClone(TEST_SESSION);
        session.id = sessionId;
        session.turns = [{
          ...session.turns[0]!,
          id: shared,
          ordinal: 0,
          parentId: null,
          blocks: [{ id: blockId, kind: "text", text }],
        }];
        return session;
      };

      await store.saveSession(alice, sessionWith("0191cafe-0000-7000-8000-0000000c0a01", "0191cafe-0000-7000-8000-0000000c0c01", "the audit transcript"));
      await store.saveSession(alice, sessionWith("0191cafe-0000-7000-8000-0000000c0a02", "0191cafe-0000-7000-8000-0000000c0c02", "an output file reusing its ids"));

      const first = await store.getSession(alice, "0191cafe-0000-7000-8000-0000000c0a01");
      const second = await store.getSession(alice, "0191cafe-0000-7000-8000-0000000c0a02");
      expect(first?.turns[0]?.blocks[0]?.text).toBe("the audit transcript");
      expect(second?.turns[0]?.blocks[0]?.text, "the second session must not be lost to the first").toBe("an output file reusing its ids");

      // The first session keeps the native id; only the one that arrived into
      // an id already taken is rescoped. Nothing already stored moves.
      expect(first?.turns[0]?.id, "the session that held the id first keeps it").toBe(shared);
      expect(second?.turns[0]?.id, "the second is given its own").not.toBe(shared);

      // And captured again as it grows, the second keeps the id it was given,
      // so an annotation anchored to that turn is still anchored to it.
      const rescopedId = second!.turns[0]!.id;
      await store.saveSession(alice, sessionWith("0191cafe-0000-7000-8000-0000000c0a02", "0191cafe-0000-7000-8000-0000000c0c02", "an output file reusing its ids, grown"));
      const again = await store.getSession(alice, "0191cafe-0000-7000-8000-0000000c0a02");
      expect(again?.turns[0]?.id, "a re-capture must not renumber the turn").toBe(rescopedId);
      expect((await store.getSession(alice, "0191cafe-0000-7000-8000-0000000c0a01"))?.turns[0]?.blocks[0]?.text,
        "and the first session is still whole after the second is saved again").toBe("the audit transcript");
    });

    it("saves a session whose content carries a NUL", async () => {
      const store = implementation.create();
      const nul = String.fromCharCode(0);
      const session = structuredClone(TEST_SESSION);
      session.id = "0191cafe-0000-7000-8000-0000000c00aa";
      session.turns = session.turns.map((turn) => ({
        ...turn,
        id: turn.id.replace(/.$/u, "a"),
        blocks: turn.blocks.map((block) => ({
          ...block,
          id: block.id.replace(/.$/u, "a"),
          text: `binary output: ${nul}${nul}after`,
          data: { stdout: `bytes ${nul} here` },
        })),
      }));

      await store.saveSession(alice, session);
      const read = await store.getSession(alice, session.id);
      expect(read, "a NUL in one tool result must not lose the session").not.toBeNull();
      const text = read!.turns[0]!.blocks[0]!.text ?? "";
      expect(text, "the rest of the text survives").toContain("after");
      expect(text.includes(nul), "and the NUL itself is gone").toBe(false);
    });

    it("writes more findings than one statement can carry", async () => {
      const store = implementation.create();
      await store.saveSession(alice, TEST_SESSION);
      const findings = Array.from({ length: 10_000 }, (_, index) => ({
        kind: "api_key", start: index * 10, end: index * 10 + 8, preview: "sk-…", basis: "artifact",
      }));

      const written = await store.replaceAnnotations(alice, TEST_SESSION.id, "redaction_mask", findings, "scanner");
      expect(written.length, "every finding must be stored, not as many as fit in one statement").toBe(10_000);

      const read = await store.listAnnotations(alice, TEST_SESSION.id);
      expect(read.filter((row) => row.kind === "redaction_mask").length).toBe(10_000);
    });

    it("names the commonest reason an artifact went unread, in both stores", async () => {
      const store = implementation.create();
      const unread = (sha: string, diagnostic: string) => ({
        ...artifact(sha, []), status: "unknown_format" as const, diagnostic,
      });
      // The shas differ in their first five characters because `artifact()`
      // builds the row id out of those; sharing them would collapse all four
      // into one row and the count would prove nothing.
      //
      // The rare reason is written last and sorts last, so it is what both old
      // implementations would have reported: Postgres by `max(diagnostic)`,
      // which sorts, and the memory store by keeping whichever it read last.
      // Writing it first would let the memory store pass by luck.
      for (const sha of ["b0de0002", "c0de0003", "d0de0004"]) {
        await store.saveRawArtifact(alice, unread(sha, "aaa common reason"));
      }
      await store.saveRawArtifact(alice, unread("a0de0001", "zzz rare reason"));

      const [row] = await store.countUnparsedArtifactsBySource(alice);
      expect(row?.artifacts, "every unread artifact counts, whatever its reason").toBe(4);
      expect(
        row?.diagnostic,
        "the reason reported must be the one most artifacts actually gave",
      ).toBe("aaa common reason");
    });

    it("resolves a machine only within the tenant that owns it", async () => {
      const store = implementation.create();
      const machineId = "0191cafe-0000-7000-8000-0000000c000e";
      await store.saveMachine(alice, {
        id: machineId, tenantId: alice.tenantId, name: `scoped-${implementation.name}`,
        platform: "darwin", agentVersion: null, sourceSettings: {}, lastSeenAt: null,
      });

      expect((await store.getMachine(alice, machineId))?.id).toBe(machineId);
      expect(await store.getMachine(bob, machineId), "bob must not resolve alice's machine").toBeNull();
      expect(await store.getMachine(alice, "0191cafe-0000-7000-8000-0000000c000f")).toBeNull();
    });

    /*
      The same check, through the other column that resolves a machine.
      `findMachineByInstallation` takes a value the client invented, and two
      accounts can invent the same one. Registering resolves through it, so a
      store that answered by installation id alone would hand one account
      another account's machine to enrol into — the hole `getMachine` closes
      above, reopened beside it. Row-level security is not the backstop here:
      the in-memory store has none, and the predicate has to be explicit.
    */
    it("resolves a machine by installation only within the tenant that owns it", async () => {
      const store = implementation.create();
      const installationId = `installation-${implementation.name}-shared`;
      const machineId = "0191cafe-0000-7000-8000-0000000c001e";
      await store.saveMachine(alice, {
        id: machineId, tenantId: alice.tenantId, name: `installed-${implementation.name}`,
        platform: "darwin", agentVersion: null, sourceSettings: {}, lastSeenAt: null, installationId,
      });

      expect((await store.findMachineByInstallation(alice, installationId))?.id).toBe(machineId);
      expect(
        await store.findMachineByInstallation(bob, installationId),
        "bob must not resolve alice's machine by naming her installation",
      ).toBeNull();
      expect(await store.findMachineByInstallation(alice, "installation-nobody-has-this")).toBeNull();
    });

    it("queues, replays, and acknowledges machine commands", async () => {
      const store = implementation.create();
      const machineId = "0191cafe-0000-7000-8000-0000000c000a";
      await store.saveMachine(alice, {
        id: machineId, tenantId: alice.tenantId, name: `contract-${implementation.name}`,
        platform: "darwin", agentVersion: null, sourceSettings: {}, lastSeenAt: null,
      });

      const command = await store.createMachineCommand(alice, { machineId, kind: "materialize", payload: { jobId: "job-1" } });
      expect(command.status).toBe("pending");
      expect((await store.listUnackedMachineCommands(alice, machineId)).map((item) => item.status)).toEqual(["pending"]);

      await store.markMachineCommandsDelivered(alice, [command.id]);
      const delivered = await store.listUnackedMachineCommands(alice, machineId);
      expect(delivered[0]!.status).toBe("delivered");
      expect(delivered[0]!.deliveredAt).not.toBeNull();

      expect(await store.ackMachineCommand(alice, machineId, command.id, { status: "failed", error: "disk full" })).toBe(true);
      expect(await store.listUnackedMachineCommands(alice, machineId)).toHaveLength(0);
      expect(await store.ackMachineCommand(alice, machineId, "0191cafe-0000-7000-8000-00000000dead", { status: "completed" })).toBe(false);
    });

    it("looks up share grants by token hash across tenants", async () => {
      const store = implementation.create();
      const session = structuredClone(TEST_SESSION);
      session.id = "0191cafe-0000-7000-8000-0000000c000b";
      await store.saveSession(alice, session);
      const grant = {
        id: "0191cafe-0000-7000-8000-0000000c000c", tenantId: alice.tenantId, sessionId: session.id,
        permission: "importer" as const, tokenHash: `hash-${implementation.name}`, status: "active" as const,
        createdAt: new Date().toISOString(), expiresAt: null,
      };
      await store.saveShareGrant(alice, grant);

      const lookup = await store.getShareGrantByTokenHash(grant.tokenHash);
      expect(lookup).toMatchObject({ grantId: grant.id, tenantId: alice.tenantId, permission: "importer", status: "active" });
      expect(await store.getShareGrantByTokenHash("no-such-hash")).toBeNull();

      await store.saveShareGrant(alice, { ...grant, status: "revoked" });
      expect((await store.getShareGrantByTokenHash(grant.tokenHash))!.status).toBe("revoked");
    });

    it("keeps a redaction review, which is what a share is allowed on the strength of", async () => {
      const store = implementation.create();
      // The review points at a session, and the database enforces that.
      const reviewed = structuredClone(TEST_SESSION);
      reviewed.id = `0191cafe-0000-7000-8000-0000000c00${implementation.name === "postgres" ? "60" : "61"}`;
      await store.saveSession(alice, reviewed);
      const review = {
        id: `0191cafe-0000-7000-8000-0000000c0${implementation.name === "postgres" ? "01a" : "01b"}`,
        tenantId: alice.tenantId,
        sessionId: reviewed.id,
        reviewerUserId: alice.userId,
        status: "completed" as const,
        contentDigest: "a".repeat(64),
        masks: [{ kind: "secret", start: 4, end: 12, preview: "sk-…" }],
        completedAt: new Date().toISOString(),
      };
      await store.saveReview(alice, review);

      const read = await store.getReview(alice, review.id);
      expect(read).toMatchObject({ id: review.id, status: "completed", sessionId: reviewed.id });
      // The masks are the record of what was approved. A review that came back
      // without them would let a share be granted against nothing.
      expect(read!.masks).toEqual(review.masks);
      expect(await store.getReview(alice, "0191cafe-0000-7000-8000-00000000dead")).toBeNull();
      // And it belongs to its tenant.
      expect(await store.getReview(bob, review.id)).toBeNull();
    });

    /*
      A transfer is the one operation that deliberately writes one tenant's
      content into another, so every guard on it is application code: RLS is
      satisfied on both sides of the copy and has nothing to say about whether
      the copy should happen at all.

      Three things are pinned here, on both stores, because each was wrong on
      one of them.

       1. The recipient can see what they were offered. `transfers` is under RLS
          and holds the sender's row only, so reading it by tenant answered half
          the contract's "Incoming and outgoing transfers" — the half without
          the Accept button. The in-memory store's single shared table hid it.
       2. Accepting re-reads the sender's review against the session as it is
          now. An offer sits until somebody acts on it and the transcript it
          names keeps growing; the review that authorized the offer described
          what was there the day it was sent.
       3. One offer is answered once. Both callers read it as pending and both
          wrote a copy, because the status was only overwritten after the copy
          had landed.
    */
    it("lets the addressee find a cross-tenant offer, and answers it once on a review that still holds", async () => {
      const store = implementation.create();
      if (implementation.name === "memory") {
        (store as DevArchiveStore).accountsByEmail.set("bob@example.test", { userId: bob.userId, tenantId: bob.tenantId, email: "bob@example.test" });
      }
      const suffix = implementation.name === "postgres" ? "70" : "71";
      const session = structuredClone(TEST_SESSION);
      session.id = `0191cafe-0000-7000-8000-0000000c00${suffix}`;
      await store.saveSession(alice, session);
      const transferId = `0191cafe-0000-7000-8000-0000000c01${suffix}`;
      await store.saveTransfer(alice, {
        id: transferId, tenantId: alice.tenantId, sessionId: session.id, senderEmail: "alice@example.test",
        recipientEmail: "bob@example.test", status: "pending", createdAt: new Date().toISOString(),
      });
      await store.createTransferOffer(alice, { id: transferId, sessionId: session.id, recipientEmail: "bob@example.test" });

      expect((await store.listTransfers(bob)).map((transfer) => transfer.id), "addressed to bob, so bob can see it").toContain(transferId);
      expect((await store.listTransfers(alice)).map((transfer) => transfer.id), "and the sender still sees their own").toContain(transferId);

      // Unreviewed content does not cross the boundary, whoever asks.
      await expect(store.acceptTransferOffer(bob, transferId)).rejects.toThrow("transfer_review_stale");

      const stored = (await store.getSession(alice, session.id))!;
      const digest = sessionContentDigest(stored);
      await store.saveReview(alice, {
        id: `0191cafe-0000-7000-8000-0000000c02${suffix}`, tenantId: alice.tenantId, sessionId: session.id,
        reviewerUserId: alice.userId, status: "completed", contentDigest: digest, masks: [],
        completedAt: new Date().toISOString(),
      });
      expect((await store.getCurrentReview(alice, session.id, digest))?.contentDigest).toBe(digest);
      expect(await store.getCurrentReview(alice, session.id, "b".repeat(64)), "a digest of other content is not this review").toBeNull();
      expect(await store.getCurrentReview(bob, session.id, digest), "bob must not resolve alice's review").toBeNull();

      const outcomes = await Promise.allSettled([
        store.acceptTransferOffer(bob, transferId),
        store.acceptTransferOffer(bob, transferId),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled"), "one accept wins").toHaveLength(1);
      const copies = (await store.listSessions(bob, { limit: 50 })).items
        .filter((held) => held.provenance.at(-1)?.sourceId === `transfer:${transferId}:${session.id}`);
      expect(copies, "and the recipient holds exactly one copy").toHaveLength(1);
      expect(copies[0]!.visibility).toEqual({ scope: "private", ownerId: bob.userId });
    });

  });
}
