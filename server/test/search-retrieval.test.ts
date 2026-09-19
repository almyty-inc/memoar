import { describe, expect, it } from "vitest";
import type { ArchivedSession, RedactionStatus, TenantContext } from "../src/archive-store.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { TEST_CONTEXT, TEST_SESSION } from "./fixtures/archive.js";
import {
  DeterministicLexicalBackend,
  PackService,
  SearchService,
  type SearchBackend,
  type SearchCandidate,
  type SemanticSearchProvider,
} from "../src/search.js";

const CLOCK = (): Date => new Date("2026-08-18T00:00:00.000Z");

const PACK_REQUEST = {
  query: "archive parser decision",
  maxTokens: 64,
  maxEvidence: 1,
  maxSessions: 1,
  maxExcerptChars: 80,
  freshnessPolicy: "mixed" as const,
  staleAfterDays: 30,
};

function sessionWith(id: string, redactionStatus: RedactionStatus): ArchivedSession {
  return { ...structuredClone(TEST_SESSION), id, redactionStatus };
}

async function packOver(sessions: readonly ArchivedSession[], overrides: Partial<typeof PACK_REQUEST> = {}): Promise<Record<string, unknown>> {
  const store = new DevArchiveStore();
  for (const session of sessions) await store.saveSession(TEST_CONTEXT, session);
  const search = new SearchService(new DeterministicLexicalBackend(store), {
    search: () => Promise.reject(new Error("semantic_provider_unavailable")),
  });
  return new PackService(search, CLOCK).build(TEST_CONTEXT, { ...PACK_REQUEST, ...overrides });
}

/**
 * A pack is evidence an agent is expected to cite. The turn range printed next
 * to an excerpt is the citation, so it has to name the turns the excerpt
 * actually carries — not the turns it would have carried had the budget been
 * bigger.
 */
describe("pack citations", () => {
  it("names only the turns the truncated excerpt actually carries", async () => {
    const pack = await packOver([TEST_SESSION]);
    const evidence = pack.evidence as { turnStart: number; turnEnd: number; excerpt: string }[];
    const cited = evidence[0]!;

    // The fixture's first turn alone overruns an 80-character excerpt, so the
    // second turn — the one that holds the actual decision — is not in the pack.
    expect(cited.excerpt).not.toContain("[turn 1]");
    expect(cited.turnEnd, "cited a turn the excerpt does not contain").toBe(0);
    expect(pack.markdown).toContain(`turns ${cited.turnStart}-${cited.turnEnd}`);
    expect(pack.markdown as string).not.toContain("turns 0-1");
  });

  it("still names the whole range when the whole range fits", async () => {
    const pack = await packOver([TEST_SESSION], { maxTokens: 4_000, maxExcerptChars: 20_000 });
    const evidence = pack.evidence as { turnStart: number; turnEnd: number; excerpt: string }[];
    expect(evidence[0]!.excerpt).toContain("[turn 1]");
    expect(evidence[0]!.turnEnd).toBe(1);
  });
});

/**
 * Sessions carry `clear | findings | reviewed`; a pack reports
 * `clear | findings | mixed`. Two vocabularies, and the mapping between them is
 * the whole finding: "reviewed" means secrets were found and then reviewed, so
 * a pack built from reviewed evidence is not a pack with nothing in it.
 */
describe("pack redaction status", () => {
  it("does not report evidence from a reviewed session as clear", async () => {
    const pack = await packOver([sessionWith(TEST_SESSION.id, "reviewed")]);
    expect((pack.evidence as unknown[]).length).toBe(1);
    expect(pack.redactionStatus, "a reviewed session carries findings").toBe("findings");
  });

  it("reports mixed when clear and reviewed evidence sit in the same pack", async () => {
    const pack = await packOver(
      [sessionWith(TEST_SESSION.id, "clear"), sessionWith("0191cafe-0000-7000-8000-00000000e001", "reviewed")],
      { maxEvidence: 2, maxSessions: 2, maxTokens: 400 },
    );
    expect((pack.evidence as unknown[]).length).toBe(2);
    expect(pack.redactionStatus).toBe("mixed");
  });

  it("still reports clear when every session is clear", async () => {
    const pack = await packOver([sessionWith(TEST_SESSION.id, "clear")]);
    expect(pack.redactionStatus).toBe("clear");
  });
});

class CountingBackend implements SearchBackend {
  calls = 0;

  constructor(private readonly outcome: () => Promise<SearchCandidate[]> = () => Promise.resolve([])) {}

  lexical(): Promise<SearchCandidate[]> {
    this.calls += 1;
    return this.outcome();
  }
}

function semanticProvider(outcome: () => Promise<SearchCandidate[]>): SemanticSearchProvider {
  return { search: outcome };
}

const CONTEXT: TenantContext = TEST_CONTEXT;

describe("search legs", () => {
  it("does not run the lexical query for a semantic-only search", async () => {
    const backend = new CountingBackend();
    const service = new SearchService(backend, semanticProvider(() => Promise.resolve([])));

    const result = await service.execute(CONTEXT, "archive", "semantic", {}, 10);

    expect(result.realizedMode).toBe("semantic");
    expect(backend.calls, "a semantic search paid for a lexical query it never read").toBe(0);
  });

  it("still falls back to lexical when the semantic provider is unavailable", async () => {
    const backend = new CountingBackend();
    const service = new SearchService(backend, semanticProvider(() => Promise.reject(new Error("semantic_provider_unavailable"))));

    const result = await service.execute(CONTEXT, "archive", "semantic", {}, 10);

    expect(result.realizedMode).toBe("lexical");
    expect(result.semanticFailure).toBe("semantic_provider_unavailable");
    expect(backend.calls).toBe(1);
  });

  /**
   * The lexical promise used to be created first and read last, so between a
   * lexical rejection and the semantic leg settling it had no handler attached.
   * Node's default for an unhandled rejection is to terminate the process: a
   * database blip during one search took the server down rather than returning
   * a 500 for that request.
   */
  it("observes a lexical failure that lands while the semantic leg is in flight", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", record);
    try {
      const backend = new CountingBackend(() => Promise.reject(new Error("lexical_backend_down")));
      const service = new SearchService(backend, semanticProvider(async () => {
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        return [];
      }));

      await expect(service.execute(CONTEXT, "archive", "hybrid", {}, 10)).rejects.toThrow("lexical_backend_down");
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      expect(unhandled, "the lexical rejection went unobserved and would have killed the process").toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});
