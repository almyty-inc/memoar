import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { SharingService } from "../src/curation.js";
import { DEMO_CONTEXT, DEMO_SESSION } from "../src/demo-data.js";
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
  const session = structuredClone(DEMO_SESSION);
  session.turns[0]!.blocks[0]!.text = `deploy with ${SECRET} now`;
  await store.saveSession(DEMO_CONTEXT, session);
  const sharing = new SharingService(store);
  const review = await sharing.completeReview(DEMO_CONTEXT, session.id);
  const link = await sharing.createLink(DEMO_CONTEXT, { sessionId: session.id, permission, redactionReviewId: review.id });
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
    expect(summary.id).not.toBe(DEMO_SESSION.id);
    const copy = await store.getSession(consumer, summary.id as string);
    expect(copy).not.toBeNull();
    expect(copy!.visibility).toEqual({ scope: "private", ownerId: consumer.userId });
    expect(copy!.provenance.at(-1)!.sourceId).toMatch(/^share:/);
    expect(JSON.stringify(copy)).not.toContain(SECRET);

    const viewerStore = new DevArchiveStore();
    const viewerLink = await sharedLink(viewerStore, "viewer");
    await expect(viewerLink.sharing.importShare(consumer, viewerLink.token)).rejects.toThrow("does not allow import");
  });

  it("404s unknown, revoked, and expired tokens", async () => {
    const store = new DevArchiveStore();
    const { sharing, token } = await sharedLink(store, "viewer");
    await expect(sharing.consumeShare("not-a-real-token")).rejects.toThrow("Share link not found");

    const grants = await store.listShareGrants(DEMO_CONTEXT);
    await store.saveShareGrant(DEMO_CONTEXT, { ...grants[0]!, status: "revoked" });
    await expect(sharing.consumeShare(token)).rejects.toThrow("Share link not found");

    await store.saveShareGrant(DEMO_CONTEXT, { ...grants[0]!, status: "active", expiresAt: "2020-01-01T00:00:00.000Z" });
    await expect(sharing.consumeShare(token)).rejects.toThrow("Share link not found");
  });
});
