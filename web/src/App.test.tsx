import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { MemoarApiClient, memoarApi } from './lib/api';

describe('Memoar archive app', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '#/timeline');
    window.sessionStorage.clear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  /*
    These rendered the whole app against a sample archive and then asserted the
    sample's own content — a search that found "Fix session parser branch
    recovery" because the fixture contained it. They exercised the invented data
    as much as the app. With the sample archive gone, the app is driven by a
    stubbed client instead, which is the only honest way to test a screen that
    has nothing of its own to show.
  */
  it('reports a failure to reach the archive rather than showing something', async () => {
    vi.spyOn(memoarApi, 'loadDashboard').mockRejectedValue(new Error('Archive unreachable'));
    vi.spyOn(memoarApi, 'currentUser').mockRejectedValue(new Error('no identity'));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Archive connection failed' })).toBeInTheDocument();
    expect(screen.getByText('Archive unreachable')).toBeInTheDocument();
  });

  it('shows the archive it was given', async () => {
    vi.spyOn(memoarApi, 'currentUser').mockResolvedValue({ id: 'u-1', email: 'ada@example.test', displayName: 'Ada Lovelace' });
    vi.spyOn(memoarApi, 'loadDashboard').mockResolvedValue({
      timeline: [{
        date: '2026-08-20',
        sessions: [{
          id: 's-1', title: 'Fix the ingest pipeline', summary: 'Archived coding session',
          source: 'claude-code', sourceLabel: 'Claude Code', workspace: '/workspace/memoar', branch: 'main',
          machine: 'workstation', model: 'Unknown model', createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:00.000Z', turnCount: 2, tokenCount: 0, durationMinutes: 0,
          redactionStatus: 'clear', tags: [],
        }],
      }],
      archivedSessions: 41,
      collections: [], grants: [], transfers: [], machines: [], apiKeys: [],
    });

    render(<App />);

    // The rows themselves are virtualized and need a measured scroll box that
    // jsdom does not give them; the summary is what this asserts, and it is the
    // part that used to be invented.
    expect(await screen.findByText('41')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pick up where you left off.' })).toBeInTheDocument();
    expect(screen.queryByText('Demo archive'), 'there is no demo archive any more').not.toBeInTheDocument();
  });

  it('refuses to invent an archive when no API URL is configured', async () => {
    // It used to answer from a sample archive, so a deployment that had lost
    // its VITE_API_URL looked like a working product full of sessions that
    // belonged to nobody. There is no substitute for the archive.
    const client = new MemoarApiClient('');

    await expect(client.loadDashboard()).rejects.toThrow(/No archive endpoint is configured/);
    await expect(client.search('redaction')).rejects.toThrow(/No archive endpoint is configured/);
    await expect(client.listMemory()).rejects.toThrow();
  });
  it('persists an OAuth callback session and scrubs it from the URL', () => {
    const client = new MemoarApiClient('http://memoar.test/v1');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    window.history.replaceState(null, '', `/#access_token=callback-token&expires_at=${encodeURIComponent(expiresAt)}`);

    expect(client.consumeOAuthCallback()).toBe(true);
    expect(client.authenticated).toBe(true);
    expect(window.location.hash).toBe('#/timeline');
    expect(window.location.href).not.toContain('callback-token');
  });

});
