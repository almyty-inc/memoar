import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoarApiClient } from './api';

/**
 * Which way a transfer points.
 *
 * The client decided this by testing the recipient address for
 * `@local.invalid` — a domain that exists in one development fixture and
 * nowhere else. Every real transfer therefore came back "outgoing", including
 * the ones addressed to the reader, so the Accept and Decline branch in the
 * Sharing view could not be reached by anybody.
 */
const ARCHIVE = 'https://api.memoar.test/v1';

function archiveWith(transfers: unknown[], me: string | null) {
  const routes: Record<string, unknown> = {
    '/sessions/timeline': { groups: [], total: 0, nextCursor: null },
    '/collections': { items: [] },
    '/sharing/links': { items: [] },
    '/sharing/transfers': { items: transfers },
    '/machines': { items: [] },
    '/auth/api-keys': { items: [] },
  };
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    const path = input.slice(ARCHIVE.length).split('?')[0]!;
    if (path === '/auth/me') {
      return Promise.resolve(me === null
        ? new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
        : Response.json({ id: 'u-1', email: me, displayName: me }));
    }
    return Promise.resolve(Response.json(routes[path] ?? {}));
  }));
}

function transfer(recipientEmail: string) {
  return {
    id: 't-1',
    sessionId: 's-1',
    senderEmail: 'bob@example.test',
    recipientEmail,
    status: 'pending',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('a transfer in the dashboard', () => {
  it('is incoming when it is addressed to the signed-in account', async () => {
    archiveWith([transfer('ada@example.test')], 'ada@example.test');

    const dashboard = await new MemoarApiClient(ARCHIVE).loadDashboard();

    expect(dashboard.transfers[0]?.direction).toBe('incoming');
  });

  it('is outgoing when it is addressed to somebody else', async () => {
    archiveWith([transfer('bob@example.test')], 'ada@example.test');

    const dashboard = await new MemoarApiClient(ARCHIVE).loadDashboard();

    expect(dashboard.transfers[0]?.direction).toBe('outgoing');
  });

  it('still loads the rest of the archive when the identity cannot be read', async () => {
    archiveWith([transfer('ada@example.test')], null);

    const dashboard = await new MemoarApiClient(ARCHIVE).loadDashboard();

    // Nothing is claimed about a direction that cannot be worked out, and the
    // dashboard the reader asked for still arrives.
    expect(dashboard.transfers[0]?.direction).toBe('outgoing');
    expect(dashboard.archivedSessions).toBe(0);
  });
});
