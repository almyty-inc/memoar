import { describe, expect, it } from "vitest";
import { AnnotationService, CollectionService } from "../src/curation.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";

describe("membership reads", () => {
  it("lists annotations, optionally filtered by session", async () => {
    const store = new DevArchiveStore();
    const other = structuredClone(TEST_SESSION);
    other.id = "0191cafe-0000-7000-8000-0000000000f1";
    other.source = { ...other.source, nativeSessionId: "membership-other-1" };
    await store.saveSession(TEST_CONTEXT, TEST_SESSION);
    await store.saveSession(TEST_CONTEXT, other);
    const annotations = new AnnotationService(store);
    await annotations.create(TEST_CONTEXT, { sessionId: TEST_SESSION.id, kind: "note", value: { text: "first" } });
    await annotations.create(TEST_CONTEXT, { sessionId: other.id, kind: "note", value: { text: "second" } });

    expect((await annotations.list(TEST_CONTEXT)).items).toHaveLength(2);
    const filtered = await annotations.list(TEST_CONTEXT, other.id);
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]!.sessionId).toBe(other.id);
  });

  it("lists a collection's sessions as summaries and 404s for unknown collections", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(TEST_CONTEXT, TEST_SESSION);
    const collections = new CollectionService(store);
    const created = await collections.create(TEST_CONTEXT, { name: "reads" });
    const collectionId = created.id as string;

    expect((await collections.listSessions(TEST_CONTEXT, collectionId)).items).toHaveLength(0);
    await collections.setMembership(TEST_CONTEXT, collectionId, TEST_SESSION.id, true);
    const members = await collections.listSessions(TEST_CONTEXT, collectionId);
    expect(members.items).toHaveLength(1);
    expect(members.items[0]).toMatchObject({ id: TEST_SESSION.id, title: TEST_SESSION.title });

    await expect(collections.listSessions(TEST_CONTEXT, "0191cafe-0000-7000-8000-00000000dead"))
      .rejects.toThrow("Collection not found");
  });
});
