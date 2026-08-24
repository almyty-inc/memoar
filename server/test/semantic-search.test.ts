import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { DefaultPipelineSeedFactory, FormatDetector, IngestPipeline, MemoryObjectStorage, SecretScanner } from "../src/ingest.js";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { DeterministicEmbeddingProvider, embeddingProviderFromEnv, HttpEmbeddingProvider } from "../src/search.js";

const context: TenantContext = {
  tenantId: "0191cafe-0000-7000-8000-0000000000b1",
  userId: "0191cafe-0000-7000-8000-0000000000b2",
  scopes: ["ingest:write"],
  authType: "machine",
  machineId: "0191cafe-0000-7000-8000-0000000000b3",
};

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  for (const [index, component] of left.entries()) dot += component * (right[index] ?? 0);
  return dot;
}

describe("embedding providers", () => {
  it("produces deterministic unit-norm vectors of the configured dimension", async () => {
    const provider = new DeterministicEmbeddingProvider(768);
    const first = await provider.embed("preserve the native parent id during normalization");
    const second = await provider.embed("preserve the native parent id during normalization");
    expect(first).toHaveLength(768);
    expect(second).toEqual(first);
    let squares = 0;
    for (const component of first) squares += component * component;
    expect(Math.abs(Math.sqrt(squares) - 1)).toBeLessThan(1e-9);
  });

  it("ranks related text above unrelated text by cosine similarity", async () => {
    const provider = new DeterministicEmbeddingProvider(768);
    const query = await provider.embed("archive parser parent reference normalization");
    const related = await provider.embed("the parser dropped parent references, preserve the parent id during normalization");
    const unrelated = await provider.embed("croissant recipes require cold butter and patience");
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it("selects providers from the environment and fails loudly on bad configuration", () => {
    expect(embeddingProviderFromEnv({})).toBeNull();
    expect(embeddingProviderFromEnv({ MEMOAR_EMBEDDINGS_PROVIDER: "disabled" })).toBeNull();
    expect(embeddingProviderFromEnv({ MEMOAR_EMBEDDINGS_PROVIDER: "deterministic", MEMOAR_EMBEDDINGS_DIMENSIONS: "32" }))
      .toBeInstanceOf(DeterministicEmbeddingProvider);
    expect(embeddingProviderFromEnv({
      MEMOAR_EMBEDDINGS_PROVIDER: "openai",
      MEMOAR_EMBEDDINGS_API_KEY: "test-not-a-real-key",
    })).toBeInstanceOf(HttpEmbeddingProvider);
    expect(() => embeddingProviderFromEnv({ MEMOAR_EMBEDDINGS_PROVIDER: "openai" })).toThrow(/MEMOAR_EMBEDDINGS_API_KEY/);
    expect(() => embeddingProviderFromEnv({ MEMOAR_EMBEDDINGS_PROVIDER: "cursed" })).toThrow(/Unknown/);
  });
});

describe("worker embedding persistence", () => {
  it("persists a session embedding after parsing when a provider is configured", async () => {
    const store = new DevArchiveStore();
    const objects = new MemoryObjectStorage();
    const bytes = await readFile(resolve(process.cwd(), "../contracts/fixtures/claude-code/v1/session-1/input/session.jsonl"));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `tenants/${context.tenantId}/raw/${sha256}`;
    await objects.put(objectKey, bytes);
    await store.saveRawArtifact(context, {
      id: "0191cafe-0000-7000-8000-0000000000b4",
      tenantId: context.tenantId,
      sessionIds: [],
      sha256,
      size: bytes.byteLength,
      objectKey,
      status: "stored",
      source: "claude-code",
      sourcePath: "embed/session.jsonl",
      capturedAt: "2026-08-19T00:00:00.000Z",
      diagnostic: null,
    });
    const pipeline = new IngestPipeline(
      store, objects, new ParserRegistry(), new FormatDetector(), new SecretScanner(), new DefaultPipelineSeedFactory(),
      new DeterministicEmbeddingProvider(64),
    );
    const result = await pipeline.process(context, sha256);
    expect(result.status).toBe("parsed");
    const embedding = store.getSessionEmbedding(context, result.sessionIds[0]!);
    expect(embedding).toHaveLength(64);
  });
});
