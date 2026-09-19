import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { SharingService } from "../src/curation.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";

/** Built at runtime so the repo's own secret scan does not flag this fixture. */
const LIVE_KEY_FIXTURE = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");

const sender: TenantContext = TEST_CONTEXT;
/** Dev identities are addressed by this convention, as listTransfers uses. */
const RECIPIENT_EMAIL = "0191cafe-0000-7000-8000-0000000000c2@local.invalid";

const recipient: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000c1",
  userId: "0191cafe-0000-7000-8000-0000000000c2",
  scopes: ["*"],
  authType: "dev",
};

describe("direct transfer", () => {
  it("copies the canonical session and provenance into the recipient tenant on acceptance", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(sender, TEST_SESSION);
    const sharing = new SharingService(store);

    const review = await sharing.completeReview(sender, TEST_SESSION.id);
    const transfer = await sharing.requestTransfer(
      sender,
      { sessionId: TEST_SESSION.id, recipientEmail: RECIPIENT_EMAIL, redactionReviewId: review.id },
      "sender@example.test",
    );
    expect(transfer.status).toBe("pending");

    const summary = await sharing.acceptTransfer(recipient, transfer.id);
    const copiedId = summary.id as string;
    expect(copiedId).not.toBe(TEST_SESSION.id);

    const copied = await store.getSession(recipient, copiedId);
    expect(copied).not.toBeNull();
    expect(copied!.visibility).toEqual({ scope: "private", ownerId: recipient.userId });
    expect(copied!.turns).toHaveLength(TEST_SESSION.turns.length);
    expect(copied!.turns.map((turn) => turn.id)).not.toEqual(TEST_SESSION.turns.map((turn) => turn.id));
    expect(copied!.turns[1]!.parentId).toBe(copied!.turns[0]!.id);
    expect(copied!.turns[0]!.blocks[0]!.text).toBe(TEST_SESSION.turns[0]!.blocks[0]!.text);
    const imported = copied!.provenance.at(-1)!;
    expect(imported.kind).toBe("import");
    expect(imported.sourceId).toBe(`transfer:${transfer.id}:${TEST_SESSION.id}`);

    expect(await store.getSession(recipient, TEST_SESSION.id)).toBeNull();
    expect((await store.getTransfer(sender, transfer.id))!.status).toBe("accepted");
    await expect(sharing.acceptTransfer(recipient, transfer.id)).rejects.toThrow("Pending transfer not found");
  });

  it("requires a current redaction review before a transfer can be requested", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(sender, TEST_SESSION);
    const sharing = new SharingService(store);
    await expect(sharing.requestTransfer(
      sender,
      { sessionId: TEST_SESSION.id, recipientEmail: RECIPIENT_EMAIL, redactionReviewId: "0191cafe-0000-7000-8000-0000000000ff" },
      "sender@example.test",
    )).rejects.toThrow();
  });

  it("snapshots resolved masks on review completion and strips secrets plus raw tool payloads from the copy", async () => {
    const store = new DevArchiveStore();
    const secret = LIVE_KEY_FIXTURE;
    const session = structuredClone(TEST_SESSION);
    session.id = "0191cafe-0000-7000-8000-0000000000d1";
    session.source = { ...session.source, nativeSessionId: "transfer-secret-1" };
    session.turns[0]!.blocks[0]!.text = `use token ${secret} to authenticate`;
    session.turns[1]!.blocks.push({
      id: "0191cafe-0000-7000-8000-0000000000d2",
      kind: "tool_call",
      name: "read_file",
      callId: "call-secret-1",
      data: { path: "/etc/secrets.env", raw: "API_TOKEN=very-secret" },
    });
    await store.saveSession(sender, session);
    await store.createAnnotation(sender, {
      sessionId: session.id,
      kind: "redaction_mask",
      value: { kind: "api_key", start: 10, end: 42, preview: "sk_l…uvwx" },
    });
    const sharing = new SharingService(store);

    const review = await sharing.completeReview(sender, session.id);
    expect(review.masks).toHaveLength(1);
    expect(review.masks[0]).toMatchObject({ kind: "api_key", preview: "sk_l…uvwx" });

    const transfer = await sharing.requestTransfer(
      sender,
      { sessionId: session.id, recipientEmail: RECIPIENT_EMAIL, redactionReviewId: review.id },
      "sender@example.test",
    );
    const summary = await sharing.acceptTransfer(recipient, transfer.id);
    const copied = await store.getSession(recipient, summary.id as string);
    expect(copied!.turns[0]!.blocks[0]!.text).toContain("[REDACTED api_key]");
    expect(JSON.stringify(copied)).not.toContain(secret);
    const tool = copied!.turns[1]!.blocks.find((block) => block.kind === "tool_call" && block.callId === "call-secret-1");
    expect(tool!.data).toEqual({ memoarRedacted: "raw payload removed by redaction projection" });
    const original = await store.getSession(sender, session.id);
    expect(original!.turns[0]!.blocks[0]!.text).toContain(secret);
  });
});

describe("a transfer offer is answered once, on terms that still hold", () => {
  async function offered(store: DevArchiveStore): Promise<{ sharing: SharingService; transferId: string }> {
    await store.saveSession(sender, TEST_SESSION);
    const sharing = new SharingService(store);
    const review = await sharing.completeReview(sender, TEST_SESSION.id);
    const transfer = await sharing.requestTransfer(
      sender,
      { sessionId: TEST_SESSION.id, recipientEmail: RECIPIENT_EMAIL, redactionReviewId: review.id },
      "sender@example.test",
    );
    return { sharing, transferId: transfer.id };
  }

  /*
    An offer sits until the recipient acts on it, and the session it names keeps
    growing in the meantime — the agent appends to a transcript it has already
    uploaded and the archive updates the same row. The sender reviewed what was
    there when they offered it; accepting copied whatever was there by then.
  */
  it("refuses an accept once the session has grown past the sender's review", async () => {
    const store = new DevArchiveStore();
    const { sharing, transferId } = await offered(store);

    const session = (await store.getSession(sender, TEST_SESSION.id))!;
    session.turns.push({
      id: "0191cafe-0000-7000-8000-00000000f001",
      ordinal: 2,
      parentId: session.turns.at(-1)!.id,
      role: "user",
      createdAt: "2026-08-18T09:00:00.000Z",
      blocks: [{ id: "0191cafe-0000-7000-8000-00000000f002", kind: "text", text: `unreviewed ${LIVE_KEY_FIXTURE}` }],
    });
    session.updatedAt = "2026-08-18T09:00:00.000Z";
    await store.saveSession(sender, session);

    const refusal: unknown = await sharing.acceptTransfer(recipient, transferId).catch((error: unknown) => error);
    expect(refusal, "an unreviewed session must not be accepted into another tenant").toBeInstanceOf(Error);
    expect((await store.listSessions(recipient, { limit: 50 })).items, "nothing crossed the boundary").toHaveLength(0);
    const problem = refusal as { getStatus: () => number; getResponse: () => { code?: string } };
    expect(problem.getStatus()).toBe(409);
    expect(problem.getResponse().code).toBe("redaction_review_required");
    // The offer is not spent by the refusal: reviewing it again lets the same
    // offer be accepted, rather than stranding it as permanently unanswerable.
    await sharing.completeReview(sender, session.id);
    const summary = await sharing.acceptTransfer(recipient, transferId);
    expect(summary.id).toBeTypeOf("string");
  });

  /*
    Two clicks on Accept, or a retry after a slow response. Both calls read the
    offer as pending and both wrote a copy, because the status was only
    overwritten after the copy had landed.
  */
  it("copies once when the same offer is accepted twice at once", async () => {
    const store = new DevArchiveStore();
    const { sharing, transferId } = await offered(store);

    const outcomes = await Promise.allSettled([
      sharing.acceptTransfer(recipient, transferId),
      sharing.acceptTransfer(recipient, transferId),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await store.listSessions(recipient, { limit: 50 })).items, "one accept, one copy").toHaveLength(1);
  });
});

describe("declining a transfer", () => {
  it("moves the offer off pending for both sides and copies nothing", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(sender, TEST_SESSION);
    const sharing = new SharingService(store);
    const review = await sharing.completeReview(sender, TEST_SESSION.id);
    const transfer = await sharing.requestTransfer(
      sender,
      { sessionId: TEST_SESSION.id, recipientEmail: RECIPIENT_EMAIL, redactionReviewId: review.id },
      "sender@example.test",
    );

    await sharing.declineTransfer(recipient, transfer.id);

    // The recipient must not end up holding the session they refused.
    const held = await store.listSessions(recipient, { limit: 50 });
    expect(held.items).toHaveLength(0);

    // The sender sees the refusal rather than a transfer stuck on pending.
    const senderView = await store.listTransfers(sender);
    expect(senderView.find((entry) => entry.id === transfer.id)?.status).toBe("declined");

    // A declined offer is spent: it can be neither declined nor accepted again.
    await expect(sharing.declineTransfer(recipient, transfer.id)).rejects.toThrow(/not found/i);
    await expect(sharing.acceptTransfer(recipient, transfer.id)).rejects.toThrow(/not found/i);
  });

  it("refuses a transfer addressed to somebody else", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(sender, TEST_SESSION);
    const sharing = new SharingService(store);
    const review = await sharing.completeReview(sender, TEST_SESSION.id);
    const transfer = await sharing.requestTransfer(
      sender,
      { sessionId: TEST_SESSION.id, recipientEmail: "somebody-else@example.test", redactionReviewId: review.id },
      "sender@example.test",
    );
    await expect(sharing.declineTransfer(recipient, transfer.id)).rejects.toThrow();
  });
});
