import { describe, expect, it } from "vitest";
import { SharingService } from "../src/curation.js";
import { DEMO_CONTEXT, DEMO_SESSION } from "../src/demo-data.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";

const TEAM_ID = "0191cafe-0000-7000-8000-0000000000e1";

describe("session visibility PATCH", () => {
  it("rejects widening beyond private without a completed redaction review", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(DEMO_CONTEXT, DEMO_SESSION);
    const sharing = new SharingService(store);
    await expect(sharing.updateVisibility(DEMO_CONTEXT, DEMO_SESSION.id, { visibility: { scope: "team", teamId: TEAM_ID } }))
      .rejects.toMatchObject({ response: { code: "redaction_review_required" } });
    await expect(sharing.updateVisibility(DEMO_CONTEXT, DEMO_SESSION.id, {
      visibility: { scope: "org" },
      redactionReviewId: "0191cafe-0000-7000-8000-0000000000ff",
    })).rejects.toMatchObject({ response: { code: "redaction_review_required" } });
    const session = await store.getSession(DEMO_CONTEXT, DEMO_SESSION.id);
    expect(session!.visibility.scope).toBe(DEMO_SESSION.visibility.scope);
  });

  it("widens with a current review, preserves the owner, and narrows back without one", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(DEMO_CONTEXT, DEMO_SESSION);
    const sharing = new SharingService(store);

    const review = await sharing.completeReview(DEMO_CONTEXT, DEMO_SESSION.id);
    const widened = await sharing.updateVisibility(DEMO_CONTEXT, DEMO_SESSION.id, {
      visibility: { scope: "team", teamId: TEAM_ID },
      redactionReviewId: review.id,
    });
    expect(widened.visibility).toEqual({ scope: "team", ownerId: DEMO_SESSION.visibility.ownerId, teamId: TEAM_ID });
    expect((await store.getSession(DEMO_CONTEXT, DEMO_SESSION.id))!.visibility.scope).toBe("team");

    const narrowed = await sharing.updateVisibility(DEMO_CONTEXT, DEMO_SESSION.id, { visibility: { scope: "private" } });
    expect(narrowed.visibility).toEqual({ scope: "private", ownerId: DEMO_SESSION.visibility.ownerId });
  });

  it("rejects widening when the session content changed after the review", async () => {
    const store = new DevArchiveStore();
    const session = structuredClone(DEMO_SESSION);
    await store.saveSession(DEMO_CONTEXT, session);
    const sharing = new SharingService(store);
    const review = await sharing.completeReview(DEMO_CONTEXT, session.id);
    session.turns[0]!.blocks[0]!.text = "content changed after review";
    await store.saveSession(DEMO_CONTEXT, session);
    await expect(sharing.updateVisibility(DEMO_CONTEXT, session.id, {
      visibility: { scope: "link" },
      redactionReviewId: review.id,
    })).rejects.toMatchObject({ response: { code: "redaction_review_required" } });
  });

  it("404s for a missing session", async () => {
    const sharing = new SharingService(new DevArchiveStore());
    await expect(sharing.updateVisibility(DEMO_CONTEXT, "0191cafe-0000-7000-8000-00000000dead", { visibility: { scope: "private" } }))
      .rejects.toThrow("Session not found");
  });
});
