import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { SharingService } from "../src/curation.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";

/** Built at runtime so the repo's own secret scan does not flag this fixture. */
const LIVE_KEY_FIXTURE = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");

const consumer: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000c1",
  userId: "0191cafe-0000-7000-8000-0000000000c2",
  scopes: ["*"],
  authType: "dev",
};

const SECRET = LIVE_KEY_FIXTURE;

async function sharedLink(store: DevArchiveStore, permission: "viewer" | "importer"): Promise<{ sharing: SharingService; token: string }> {
  const session = structuredClone(TEST_SESSION);
  session.turns[0]!.blocks[0]!.text = `deploy with ${SECRET} now`;
  await store.saveSession(TEST_CONTEXT, session);
  const sharing = new SharingService(store);
  const review = await sharing.completeReview(TEST_CONTEXT, session.id);
  const link = await sharing.createLink(TEST_CONTEXT, { sessionId: session.id, permission, redactionReviewId: review.id });
  return { sharing, token: link.token as string };
}

describe("public share consume/import", () => {
  it("serves a redaction-projected session for an active link without authentication context", async () => {
    const store = new DevArchiveStore();
    const { sharing, token } = await sharedLink(store, "viewer");
    const consumed = await sharing.consumeShare(token);
    expect(consumed.permission).toBe("viewer");
    const body = JSON.stringify(consumed.session);
    expect(body).not.toContain(SECRET);
    expect(body).toContain("[REDACTED");
    expect((consumed.session as { redactionStatus?: unknown }).redactionStatus).toBeUndefined();
  });

  it("imports a private provenance-linked copy for importer links and refuses viewer links", async () => {
    const store = new DevArchiveStore();
    const { sharing, token } = await sharedLink(store, "importer");
    const summary = await sharing.importShare(consumer, token);
    expect(summary.id).not.toBe(TEST_SESSION.id);
    const copy = await store.getSession(consumer, summary.id as string);
    expect(copy).not.toBeNull();
    expect(copy!.visibility).toEqual({ scope: "private", ownerId: consumer.userId });
    expect(copy!.provenance.at(-1)!.sourceId).toMatch(/^share:/);
    expect(JSON.stringify(copy)).not.toContain(SECRET);

    const viewerStore = new DevArchiveStore();
    const viewerLink = await sharedLink(viewerStore, "viewer");
    await expect(viewerLink.sharing.importShare(consumer, viewerLink.token)).rejects.toThrow("does not allow import");
  });

  /*
    The review is what a share is granted on the strength of, and the contract
    says so: "authorizes share links and transfers until the session content
    changes". A token names a session, not the snapshot that was reviewed, and
    the agent keeps appending to transcripts it has already uploaded — so a link
    minted over an approved conversation went on serving every turn added to it
    afterwards, none of them reviewed by anybody.
  */
  it("stops serving a link once the session has grown past the review that authorized it", async () => {
    const store = new DevArchiveStore();
    const { sharing, token } = await sharedLink(store, "viewer");
    expect((await sharing.consumeShare(token)).permission).toBe("viewer");

    const session = (await store.getSession(TEST_CONTEXT, TEST_SESSION.id))!;
    session.turns.push({
      id: "0191cafe-0000-7000-8000-00000000e001",
      ordinal: 2,
      parentId: session.turns.at(-1)!.id,
      role: "user",
      createdAt: "2026-08-18T09:00:00.000Z",
      blocks: [{ id: "0191cafe-0000-7000-8000-00000000e002", kind: "text", text: `and here is the customer's key ${SECRET}` }],
    });
    session.updatedAt = "2026-08-18T09:00:00.000Z";
    await store.saveSession(TEST_CONTEXT, session);

    await expect(sharing.consumeShare(token), "unreviewed turns must not leave the tenant")
      .rejects.toThrow("Share link not found");
    // Indistinguishable from an unknown token: the refusal must not tell an
    // anonymous caller that this token is real and merely stale.
    await expect(sharing.importShare(consumer, token)).rejects.toThrow("Share link not found");

    // Reviewing it again re-authorizes the same link, because the grant's scope
    // is derived at redemption rather than frozen at minting.
    await sharing.completeReview(TEST_CONTEXT, session.id);
    expect((await sharing.consumeShare(token)).permission).toBe("viewer");
  });

  /*
    `expiresAt` is whatever the client sent and `IsDateString` allows an offset.
    Compared as text against `new Date().toISOString()`, an expiry an hour past
    written as `+02:00` sorts an hour into the future.
  */
  it("expires a link by the instant it names, not by how the timestamp is spelled", async () => {
    const store = new DevArchiveStore();
    const { sharing, token } = await sharedLink(store, "viewer");
    const anHourAgo = new Date(Date.now() - 3_600_000);
    const sameInstantInBerlin = new Date(anHourAgo.getTime() + 2 * 3_600_000).toISOString().replace("Z", "+02:00");
    expect(sameInstantInBerlin > new Date().toISOString(), "and it sorts as if it were still in the future").toBe(true);

    const grants = await store.listShareGrants(TEST_CONTEXT);
    await store.saveShareGrant(TEST_CONTEXT, { ...grants[0]!, expiresAt: sameInstantInBerlin });
    await expect(sharing.consumeShare(token)).rejects.toThrow("Share link not found");
  });

  /*
    The block text was projected and everything around it was not. A session's
    title is the conversation's own title or the task somebody typed, and its
    workspace path is where they were working — which is the exact thing
    `pathScan` is offered to remove. Both went out verbatim.
  */
  it("applies the tenant's patterns to the title, summary and workspace it serves, not only to block text", async () => {
    const store = new DevArchiveStore();
    const session = structuredClone(TEST_SESSION);
    session.title = "Debug the export for dana@acme.example";
    session.summary = "Notes from /Users/frane/clients/acme on the failing export.";
    session.workspace = { ...session.workspace, path: "/Users/frane/clients/acme" };
    await store.saveSession(TEST_CONTEXT, session);
    const settings = await store.getTenantSettings(TEST_CONTEXT);
    await store.saveTenantSettings(TEST_CONTEXT, {
      ...settings,
      redaction: { ...settings.redaction, emailScan: true, pathScan: true },
    });

    const sharing = new SharingService(store);
    const review = await sharing.completeReview(TEST_CONTEXT, session.id);
    const link = await sharing.createLink(TEST_CONTEXT, { sessionId: session.id, permission: "viewer", redactionReviewId: review.id });
    const served = (await sharing.consumeShare(link.token as string)).session as { title: string; summary: string; workspace: { path: string } };

    expect(served.title).toBe("Debug the export for [REDACTED email]");
    expect(served.summary).not.toContain("/Users/frane");
    expect(served.workspace.path).not.toContain("/Users/frane");
  });

  it("404s unknown, revoked, and expired tokens", async () => {
    const store = new DevArchiveStore();
    const { sharing, token } = await sharedLink(store, "viewer");
    await expect(sharing.consumeShare("not-a-real-token")).rejects.toThrow("Share link not found");

    const grants = await store.listShareGrants(TEST_CONTEXT);
    await store.saveShareGrant(TEST_CONTEXT, { ...grants[0]!, status: "revoked" });
    await expect(sharing.consumeShare(token)).rejects.toThrow("Share link not found");

    await store.saveShareGrant(TEST_CONTEXT, { ...grants[0]!, status: "active", expiresAt: "2020-01-01T00:00:00.000Z" });
    await expect(sharing.consumeShare(token)).rejects.toThrow("Share link not found");
  });
});
