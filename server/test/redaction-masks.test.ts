import { describe, expect, it } from "vitest";
import type { ArchivedSession, TenantContext } from "../src/archive-store.js";
import { SharingService } from "../src/curation.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { SecretScanner } from "../src/ingest/detection.js";
import { applyRedactionProjection, redactionPatterns, reviewedMasks } from "../src/redaction.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";

const CUSTOMER = "Northwind Trading";
const ADDRESS = "buyer@northwind.example";

/** The tenant next door, for proving one archive's settings never reach another's. */
const OTHER: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000b1",
  userId: "0191cafe-0000-7000-8000-0000000000b2",
  scopes: ["*"],
  authType: "dev",
};

function sessionSaying(text: string): ArchivedSession {
  const session = structuredClone(TEST_SESSION);
  session.turns[0]!.blocks[0]!.text = text;
  session.turns[0]!.blocks.length = 1;
  session.turns.length = 1;
  return session;
}

const BLOCK_ID = TEST_SESSION.turns[0]!.blocks[0]!.id;

/** The block-anchored mask a person places during the review, as the API stores it. */
function maskOver(text: string, needle: string): Record<string, unknown> {
  const start = text.indexOf(needle);
  return { kind: "customer", basis: "block", blockId: BLOCK_ID, start, end: start + needle.length, preview: `${needle.slice(0, 2)}…` };
}

async function linkFor(store: DevArchiveStore, context: TenantContext, session: ArchivedSession): Promise<{ sharing: SharingService; token: string }> {
  const sharing = new SharingService(store);
  const review = await sharing.completeReview(context, session.id);
  const link = await sharing.createLink(context, { sessionId: session.id, permission: "viewer", redactionReviewId: review.id });
  return { sharing, token: link.token as string };
}

describe("a mask placed during the redaction review", () => {
  it("is removed from the text a share link serves", async () => {
    // The whole point of the mandatory review: a person selects a customer's
    // name, completes the review createLink refuses to work without, shares the
    // link — and the name used to be served in full, because nothing read the
    // masks at all.
    const store = new DevArchiveStore();
    const text = `We agreed terms with ${CUSTOMER} on Tuesday.`;
    const session = sessionSaying(text);
    await store.saveSession(TEST_CONTEXT, session);
    await store.createAnnotation(TEST_CONTEXT, { sessionId: session.id, kind: "redaction_mask", value: maskOver(text, CUSTOMER) });

    const { sharing, token } = await linkFor(store, TEST_CONTEXT, session);
    const consumed = await sharing.consumeShare(token);

    const body = JSON.stringify(consumed.session);
    expect(body).not.toContain(CUSTOMER);
    expect(body).toContain("[REDACTED customer]");
    // Only the selected range: the rest of the sentence still reads.
    expect(body).toContain("on Tuesday");
  });

  it("is removed from a copy imported through the link as well", async () => {
    const store = new DevArchiveStore();
    const text = `Escalate to ${CUSTOMER} before Friday.`;
    const session = sessionSaying(text);
    await store.saveSession(TEST_CONTEXT, session);
    await store.createAnnotation(TEST_CONTEXT, { sessionId: session.id, kind: "redaction_mask", value: maskOver(text, CUSTOMER) });

    const sharing = new SharingService(store);
    const review = await sharing.completeReview(TEST_CONTEXT, session.id);
    const link = await sharing.createLink(TEST_CONTEXT, { sessionId: session.id, permission: "importer", redactionReviewId: review.id });
    const summary = await sharing.importShare(OTHER, link.token as string);

    expect(JSON.stringify(await store.getSession(OTHER, summary.id as string))).not.toContain(CUSTOMER);
  });

  it("is removed from a session accepted through a direct transfer", async () => {
    // requestTransfer demands a completed review just as createLink does, and
    // the copy the recipient accepted used to carry the masked text in full.
    const store = new DevArchiveStore();
    const text = `Renewal for ${CUSTOMER} is overdue.`;
    const session = sessionSaying(text);
    await store.saveSession(TEST_CONTEXT, session);
    await store.createAnnotation(TEST_CONTEXT, { sessionId: session.id, kind: "redaction_mask", value: maskOver(text, CUSTOMER) });

    // Dev identities are addressed by this convention, as listTransfers uses.
    const recipientEmail = `${OTHER.userId}@local.invalid`;
    const sharing = new SharingService(store);
    const review = await sharing.completeReview(TEST_CONTEXT, session.id);
    const transfer = await sharing.requestTransfer(TEST_CONTEXT, {
      sessionId: session.id, recipientEmail, redactionReviewId: review.id,
    }, "owner@example.test");
    const accepted = await sharing.acceptTransfer(OTHER, transfer.id);

    const copy = await store.getSession(OTHER, accepted.id as string);
    expect(JSON.stringify(copy)).not.toContain(CUSTOMER);
    expect(JSON.stringify(copy)).toContain("[REDACTED customer]");
  });

  it("is applied by offset into the block it names, and ignores the scanner's artifact offsets", () => {
    // The scanner reports byte offsets into the uploaded file. Applied to block
    // text they would blank an arbitrary run of somebody's prose, so a finding
    // without a block anchor is not a range this can act on.
    const anchored = reviewedMasks([
      { kind: "redaction_mask", value: { blockId: BLOCK_ID, start: 3, end: 8, kind: "customer" } },
      { kind: "redaction_mask", value: { start: 4096, end: 4112, kind: "api_key", basis: "artifact" } },
      { kind: "note", value: { blockId: BLOCK_ID, start: 0, end: 5 } },
    ]);

    expect(anchored).toEqual([{ blockId: BLOCK_ID, start: 3, end: 8, kind: "customer" }]);
  });

  it("survives the next capture of a transcript that is still growing", async () => {
    // Ingest replaced every redaction_mask on the session, so an agent
    // re-uploading a conversation as it grew silently destroyed the masks the
    // user had placed by hand — undoing their review every few minutes.
    const store = new DevArchiveStore();
    const session = sessionSaying("first line");
    await store.saveSession(TEST_CONTEXT, session);
    await store.createAnnotation(TEST_CONTEXT, {
      sessionId: session.id, kind: "redaction_mask", value: maskOver("first line", "first"),
    });

    await store.replaceAnnotations(TEST_CONTEXT, session.id, "redaction_mask", [
      { kind: "api_key", start: 10, end: 40, preview: "sk…wx", basis: "artifact" },
    ], "secret-scanner");

    const remaining = (await store.listAnnotations(TEST_CONTEXT, session.id)).filter((item) => item.kind === "redaction_mask");
    expect(remaining.filter((item) => item.value.basis === "block")).toHaveLength(1);
    expect(remaining.filter((item) => item.value.origin === "secret-scanner")).toHaveLength(1);
  });
});

describe("a tenant's own redaction settings", () => {
  it("decide what a share link masks", async () => {
    // secretScan / emailScan / customPatterns were validated, stored and echoed
    // back, and read by nothing: a tenant who switched emailScan on got a 200
    // and every address served verbatim on the next link.
    const store = new DevArchiveStore();
    const text = `Write to ${ADDRESS} about ${CUSTOMER}.`;
    const session = sessionSaying(text);
    await store.saveSession(TEST_CONTEXT, session);
    await store.saveTenantSettings(TEST_CONTEXT, {
      redaction: { secretScan: true, pathScan: false, emailScan: true, customPatterns: ["Northwind [A-Z]\\w+"] },
      retention: { policy: "indefinite", exemptCollected: true },
      updatedAt: new Date().toISOString(),
    });

    const { sharing, token } = await linkFor(store, TEST_CONTEXT, session);
    const body = JSON.stringify((await sharing.consumeShare(token)).session);

    expect(body).not.toContain(ADDRESS);
    expect(body).toContain("[REDACTED email]");
    expect(body).not.toContain(CUSTOMER);
    expect(body).toContain("[REDACTED custom]");
  });

  it("belong to the owner of the link, never to whoever else is on the server", async () => {
    // The projection runs in the owner's tenant context. A neighbour switching
    // their own scanning off must not change what this link serves.
    const store = new DevArchiveStore();
    const text = `Write to ${ADDRESS}.`;
    const session = sessionSaying(text);
    await store.saveSession(TEST_CONTEXT, session);
    await store.saveTenantSettings(TEST_CONTEXT, {
      redaction: { secretScan: true, pathScan: false, emailScan: true, customPatterns: [] },
      retention: { policy: "indefinite", exemptCollected: true },
      updatedAt: new Date().toISOString(),
    });
    await store.saveTenantSettings(OTHER, {
      redaction: { secretScan: false, pathScan: false, emailScan: false, customPatterns: [] },
      retention: { policy: "indefinite", exemptCollected: true },
      updatedAt: new Date().toISOString(),
    });

    const { sharing, token } = await linkFor(store, TEST_CONTEXT, session);
    expect(JSON.stringify((await sharing.consumeShare(token)).session)).not.toContain(ADDRESS);
    // And the neighbour's archive is not readable through this link at all.
    expect(await store.getSession(OTHER, session.id)).toBeNull();
  });

  it("decide what the secret scanner looks for on the way in", () => {
    const bytes = Buffer.from(`contact ${ADDRESS} and /Users/someone/work/customer`, "utf8");
    const scanner = new SecretScanner();

    expect(scanner.scan(bytes, redactionPatterns({ secretScan: true, pathScan: false, emailScan: false, customPatterns: [] }))).toHaveLength(0);
    const wider = scanner.scan(bytes, redactionPatterns({ secretScan: true, pathScan: true, emailScan: true, customPatterns: [] }));
    expect(wider.map((finding) => finding.kind).sort()).toEqual(["email", "path"]);
  });

  it("cannot break a share by storing a pattern that no longer compiles", () => {
    // Settings validation rejects an uncompilable pattern, but a stored pattern
    // outlives the code that checked it. Throwing here would serve the text
    // unmasked, which is the failure mode this must not have.
    const patterns = redactionPatterns({ secretScan: false, pathScan: false, emailScan: false, customPatterns: ["("] });
    expect(patterns).toHaveLength(0);

    const projected = applyRedactionProjection(sessionSaying("plain words"), { patterns });
    expect(projected.turns[0]!.blocks[0]!.text).toBe("plain words");
  });
});
