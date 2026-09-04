import { describe, expect, it } from "vitest";
import { ConversionService } from "../src/convert.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { InMemoryJobQueue, type ObjectStorage } from "../src/ingest.js";
import { DeterministicLexicalBackend, DisabledSemanticSearchProvider, PackService, SearchService } from "../src/search.js";

class MemoryObjects implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  put(objectKey: string, bytes: Uint8Array): Promise<void> { this.objects.set(objectKey, bytes); return Promise.resolve(); }
  get(objectKey: string): Promise<Uint8Array> {
    const bytes = this.objects.get(objectKey);
    return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`missing object: ${objectKey}`));
  }
  signedDownloadUrl(objectKey: string): Promise<string> { return Promise.resolve(`memory://${objectKey}`); }
  health(): Promise<void> { return Promise.resolve(); }
}

function servicesFor(store: DevArchiveStore, packs?: PackService): { service: ConversionService; objects: MemoryObjects; packs: PackService } {
  const search = new SearchService(new DeterministicLexicalBackend(store), new DisabledSemanticSearchProvider());
  const packService = packs ?? new PackService(search, () => new Date("2026-08-21T00:00:00.000Z"));
  const objects = new MemoryObjects();
  // The in-memory queue has no worker behind it, so the service runs the
  // conversion inline — the same path a developer without Redis gets.
  return { service: new ConversionService(store, objects, packService, new InMemoryJobQueue()), objects, packs: packService };
}

function storedPrelude(objects: MemoryObjects): string {
  expect(objects.objects.size).toBe(1);
  const stored = [...objects.objects.values()][0]!;
  const bundle = JSON.parse(new TextDecoder().decode(stored)) as { files: { path: string; base64: string }[] };
  const file = bundle.files.find((entry) => entry.path.startsWith("memoar-injection-"));
  expect(file).toBeDefined();
  return Buffer.from(file!.base64, "base64").toString("utf8");
}

describe("open conversion target", () => {
  it("converts to an arbitrary target via injection fallback with cited archive evidence and a truncation report", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(TEST_CONTEXT, TEST_SESSION);
    const { service, objects } = servicesFor(store);

    const job = await service.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "aider", fallback: "injection" });
    expect(job.status).toBe("ready");
    expect(job.resumeCommand).toContain("aider");
    expect((job.report as { fallback: boolean }).fallback).toBe(true);

    const prelude = storedPrelude(objects);
    expect(prelude).toContain("## Related archive evidence (cited)");
    expect(prelude).toContain(`## [1] ${TEST_SESSION.id} turns`);
    expect(prelude).toContain("## Session transcript (token-budgeted)");
    expect(prelude).toContain("## Truncation report");
    expect(prelude).toContain(`[${TEST_SESSION.id} turn 0]`);
  });

  it("fails the job for unknown targets when fallback is fail", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(TEST_CONTEXT, TEST_SESSION);
    const { service } = servicesFor(store);
    const job = await service.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "aider", fallback: "fail" });
    expect(job.status).toBe("failed");
    expect((job.report as { error: string }).error).toContain("unsupported_conversion_target:aider");
  });

  it("does not build packs for native targets", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(TEST_CONTEXT, TEST_SESSION);
    let packCalls = 0;
    const search = new SearchService(new DeterministicLexicalBackend(store), new DisabledSemanticSearchProvider());
    const spy = new (class extends PackService {
      override build(...args: Parameters<PackService["build"]>): ReturnType<PackService["build"]> {
        packCalls += 1;
        return super.build(...args);
      }
    })(search);
    const { service } = servicesFor(store, spy);
    const job = await service.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "claude-code", fallback: "injection" });
    expect(job.status).toBe("ready");
    expect(packCalls).toBe(0);
  });

  it("degrades to a transcript-only prelude when pack building fails", async () => {
    const store = new DevArchiveStore();
    await store.saveSession(TEST_CONTEXT, TEST_SESSION);
    const search = new SearchService(new DeterministicLexicalBackend(store), new DisabledSemanticSearchProvider());
    const broken = new (class extends PackService {
      override build(): never { throw new Error("search backend offline"); }
    })(search);
    const { service, objects } = servicesFor(store, broken);
    const job = await service.request(TEST_CONTEXT, { sessionId: TEST_SESSION.id, target: "aider", fallback: "injection" });
    expect(job.status).toBe("ready");
    const prelude = storedPrelude(objects);
    expect(prelude).not.toContain("## Related archive evidence (cited)");
    expect(prelude).toContain("## Session transcript (token-budgeted)");
  });
});
