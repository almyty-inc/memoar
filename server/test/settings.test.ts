import { describe, expect, it } from "vitest";
import type { RawArtifactRecord } from "../src/archive-store.js";
import { DEMO_CONTEXT, DEMO_SESSION } from "../src/demo-data.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { runRetentionSweep, SettingsService } from "../src/settings.js";

const DAY_MS = 24 * 3600 * 1000;

function artifactFor(sessionIds: string[], sha: string): RawArtifactRecord {
  return {
    id: sha.slice(0, 8), tenantId: DEMO_CONTEXT.tenantId, sessionIds, sha256: sha, size: 10,
    objectKey: `raw/${sha}`, status: "parsed", source: "claude-code", sourcePath: "retention/a.jsonl",
    capturedAt: new Date().toISOString(), diagnostic: null,
  };
}

describe("tenant settings", () => {
  it("returns defaults, applies partial updates, and validates input", async () => {
    const store = new DevArchiveStore();
    const service = new SettingsService(store);

    const defaults = await service.get(DEMO_CONTEXT);
    expect(defaults).toMatchObject({
      redaction: { secretScan: true, pathScan: false, emailScan: false, customPatterns: [] },
      retention: { policy: "indefinite", exemptCollected: true },
      updatedAt: null,
    });

    const updated = await service.update(DEMO_CONTEXT, { retention: { policy: "days", days: 30 } });
    expect(updated.retention).toEqual({ policy: "days", days: 30, exemptCollected: true });
    expect(updated.redaction.secretScan).toBe(true);
    expect(updated.updatedAt).not.toBeNull();
    expect((await service.get(DEMO_CONTEXT)).retention.days).toBe(30);

    const patterns = await service.update(DEMO_CONTEXT, { redaction: { customPatterns: ["ACME_[A-Z0-9]{24}"] } });
    expect(patterns.redaction.customPatterns).toEqual(["ACME_[A-Z0-9]{24}"]);
    expect(patterns.retention.days).toBe(30);

    await expect(service.update(DEMO_CONTEXT, { retention: { policy: "days", days: 0 } })).rejects.toMatchObject({ response: { code: "invalid_settings" } });
    await expect(service.update(DEMO_CONTEXT, { redaction: { customPatterns: ["[unclosed"] } })).rejects.toMatchObject({ response: { code: "invalid_settings" } });

    const narrowed = await service.update(DEMO_CONTEXT, { retention: { policy: "indefinite" } });
    expect(narrowed.retention).toEqual({ policy: "indefinite", exemptCollected: true });
  });
});

describe("retention sweep", () => {
  it("deletes expired sessions and fully-expired artifacts, exempting collected sessions", async () => {
    const store = new DevArchiveStore();
    const service = new SettingsService(store);
    const now = new Date();

    const fresh = structuredClone(DEMO_SESSION);
    const stale = structuredClone(DEMO_SESSION);
    stale.id = "0191cafe-0000-7000-8000-0000000000a2";
    stale.source = { ...stale.source, nativeSessionId: "retention-stale" };
    stale.updatedAt = new Date(now.getTime() - 400 * DAY_MS).toISOString();
    const staleCollected = structuredClone(DEMO_SESSION);
    staleCollected.id = "0191cafe-0000-7000-8000-0000000000a3";
    staleCollected.source = { ...staleCollected.source, nativeSessionId: "retention-collected" };
    staleCollected.updatedAt = stale.updatedAt;
    await store.saveSession(DEMO_CONTEXT, fresh);
    await store.saveSession(DEMO_CONTEXT, stale);
    await store.saveSession(DEMO_CONTEXT, staleCollected);
    await store.saveCollection(DEMO_CONTEXT, {
      id: "0191cafe-0000-7000-8000-0000000000a4", tenantId: DEMO_CONTEXT.tenantId,
      name: "keep", sessionIds: [staleCollected.id], updatedAt: now.toISOString(),
    });
    await store.saveRawArtifact(DEMO_CONTEXT, artifactFor([stale.id], "a".repeat(64)));
    await store.saveRawArtifact(DEMO_CONTEXT, artifactFor([stale.id, fresh.id], "b".repeat(64)));

    await service.update(DEMO_CONTEXT, { retention: { policy: "days", days: 365 } });
    const result = await runRetentionSweep(store, now);
    expect(result).toEqual({ sweptTenants: 1, deletedSessions: 1, deletedArtifacts: 1 });

    expect(await store.getSession(DEMO_CONTEXT, stale.id)).toBeNull();
    expect(await store.getSession(DEMO_CONTEXT, fresh.id)).not.toBeNull();
    expect(await store.getSession(DEMO_CONTEXT, staleCollected.id)).not.toBeNull();
    expect(await store.getRawArtifact(DEMO_CONTEXT, "a".repeat(64))).toBeNull();
    const shared = await store.getRawArtifact(DEMO_CONTEXT, "b".repeat(64));
    expect(shared).not.toBeNull();
    expect(shared!.sessionIds).toEqual([fresh.id]);
  });

  it("does nothing for indefinite retention", async () => {
    const store = new DevArchiveStore();
    const stale = structuredClone(DEMO_SESSION);
    stale.updatedAt = new Date(Date.now() - 4000 * DAY_MS).toISOString();
    await store.saveSession(DEMO_CONTEXT, stale);
    const result = await runRetentionSweep(store);
    expect(result.deletedSessions).toBe(0);
    expect(await store.getSession(DEMO_CONTEXT, stale.id)).not.toBeNull();
  });
});
