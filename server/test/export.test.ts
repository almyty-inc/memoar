import { describe, expect, it } from "vitest";
import { CanonicalBundleParser } from "../libs/parsers/src/canonical-bundle.js";
import { DEMO_CONTEXT, DEMO_SESSION } from "../src/demo-data.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { canonicalProjection, SessionsService } from "../src/sessions.js";

describe("session export", () => {
  it("exports a canonical bundle that round-trips through the canonical-bundle parser", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(DEMO_CONTEXT, DEMO_SESSION);
    const service = new SessionsService(store);

    const exported = await service.export(DEMO_CONTEXT, DEMO_SESSION.id, "canonical");
    expect(exported.contentType).toBe("application/json");
    expect(exported.filename).toBe(`${DEMO_SESSION.id}.memoar.json`);

    const seed = Object.fromEntries(Object.entries(canonicalProjection(DEMO_SESSION)).filter(([key]) => key !== "turns"));
    const parsed = new CanonicalBundleParser().parse({
      source: "canonical-bundle",
      version: "v1",
      raw: new TextEncoder().encode(exported.body),
      seed: seed as Parameters<CanonicalBundleParser["parse"]>[0]["seed"],
    });
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") throw new Error("unreachable");
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]).toEqual(canonicalProjection(DEMO_SESSION));
  });

  it("exports self-contained escaped HTML", async () => {
    const store = new DevArchiveStore();
    const session = structuredClone(DEMO_SESSION);
    session.id = "0191cafe-0000-7000-8000-0000000000b1";
    session.source = { ...session.source, nativeSessionId: "export-html-1" };
    session.title = "Export <script>alert(1)</script> check";
    session.turns[0]!.blocks[0]!.text = "inline <b>markup</b> must be escaped";
    await store.saveSession(DEMO_CONTEXT, session);
    const service = new SessionsService(store);

    const exported = await service.export(DEMO_CONTEXT, session.id, "html");
    expect(exported.contentType).toContain("text/html");
    expect(exported.body).toContain("<!doctype html>");
    expect(exported.body).toContain("Export &lt;script&gt;alert(1)&lt;/script&gt; check");
    expect(exported.body).toContain("inline &lt;b&gt;markup&lt;/b&gt; must be escaped");
    expect(exported.body).not.toContain("<script>");
    expect(exported.body).not.toContain("http://");
    expect(exported.body).not.toContain("https://");
  });

  it("rejects unknown formats and missing sessions", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(DEMO_CONTEXT, DEMO_SESSION);
    const service = new SessionsService(store);
    await expect(service.export(DEMO_CONTEXT, DEMO_SESSION.id, "pdf")).rejects.toMatchObject({ response: { code: "invalid_export_format" } });
    await expect(service.export(DEMO_CONTEXT, "0191cafe-0000-7000-8000-00000000dead", "canonical")).rejects.toThrow("Session not found");
  });
});
