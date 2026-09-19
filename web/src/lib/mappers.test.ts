import { describe, expect, it } from 'vitest';
import { mapSessionDetail } from './api/mappers';
import type { SessionSummary } from './types';

function summary(): SessionSummary {
  return {
    id: 's-1', title: 'A session', source: 'claude-code', workspace: '/w',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    turnCount: 0, models: [], machineId: null, redactionStatus: 'clear',
    visibility: { scope: 'private' }, collectionIds: [],
  } as unknown as SessionSummary;
}

/** `chunks` worth of turns, each carrying one of every token kind. */
function chunks(turnCount: number, perChunk = 25) {
  const turns = Array.from({ length: turnCount }, (_, index) => ({
    id: `t-${index}`, ordinal: index, parentId: null, role: 'assistant',
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    model: 'claude-opus-5',
    tokens: { input: 2, output: 3, cacheRead: 5 },
    blocks: [],
  }));
  const pages = [];
  for (let start = 0; start < turns.length; start += perChunk) {
    pages.push({ session: summary(), turns: turns.slice(start, start + perChunk), nextCursor: null });
  }
  return pages as unknown as Parameters<typeof mapSessionDetail>[1];
}

/**
 * The cache-read total used to be recovered by re-flattening every chunk and
 * scanning the result for a turn the loop already had, once per turn — so
 * opening a long session paid for the conversation squared before it drew
 * anything. The totals are what must not move.
 */
describe('mapping a session', () => {
  it('adds up every token kind across chunks', () => {
    const detail = mapSessionDetail(summary(), chunks(60));
    expect(detail.tokenTotals).toEqual({ input: 120, output: 180, cacheRead: 300 });
    expect(detail.turns).toHaveLength(60);
  });

  it('stays linear as the conversation grows', () => {
    // Twenty times the turns should cost far less than four hundred times the
    // work. A generous ceiling: the point is the shape, not a millisecond.
    const time = (count: number) => {
      const pages = chunks(count);
      const started = performance.now();
      mapSessionDetail(summary(), pages);
      return performance.now() - started;
    };
    time(200);
    const small = Math.max(time(200), 0.05);
    const large = time(4000);
    expect(large / small).toBeLessThan(120);
  });
});
