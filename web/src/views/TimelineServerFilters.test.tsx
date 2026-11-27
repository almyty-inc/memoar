import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { memoarApi, MemoarApiClient } from '../lib/api';
import type { Machine, SessionSummary, TimelineGroup } from '../lib/types';
import { TimelineView } from './Timeline';

function session(id: string, source: string, sourceLabel: string, updatedAt: string): SessionSummary {
  return {
    id, title: `Session ${id}`, summary: 'Archived coding session', source, sourceLabel,
    workspace: '/workspace/memoar', createdAt: updatedAt, updatedAt,
    turnCount: 2, tokenCount: 40, redactionStatus: 'clear',
  };
}

// The loaded page holds Claude Code only. Antigravity's sessions are all older.
const groups: TimelineGroup[] = [{ date: '2026-09-01', sessions: [session('cc-1', 'claude-code', 'Claude Code', '2026-09-01T09:30:00.000Z')] }];

const machines: Machine[] = [{
  id: 'm-1', name: 'laptop', platform: 'macOS', status: 'online', lastSeenAt: null, agentVersion: '1.0.0',
  sources: [
    { id: 'claude-code', label: 'Claude Code', enabled: true, sessionCount: 393, lastSyncAt: null },
    { id: 'antigravity-cli', label: 'Antigravity CLI', enabled: true, sessionCount: 655, lastSyncAt: null },
    { id: 'goose', label: 'Goose', enabled: true, sessionCount: 0, lastSyncAt: null },
  ],
}];

const older = session('ag-1', 'antigravity-cli', 'Antigravity CLI', '2026-03-04T10:00:00.000Z');

function view(props: Partial<Parameters<typeof TimelineView>[0]> = {}) {
  return render(
    <TimelineView
      groups={groups}
      machines={machines}
      archived={1048}
      asOf={Date.parse('2026-09-02T00:00:00.000Z')}
      onOpen={vi.fn()}
      onConnect={vi.fn()}
      hasMore
      loadingMore={false}
      onLoadMore={vi.fn()}
      {...props}
    />,
  );
}

// jsdom lays nothing out, so the virtual list would draw no rows at all.
const sizes = ['offsetHeight', 'offsetWidth'] as const;
const originals = sizes.map((size) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, size));
beforeAll(() => {
  for (const size of sizes) Object.defineProperty(HTMLElement.prototype, size, { configurable: true, get: () => 800 });
});
afterAll(() => {
  sizes.forEach((size, index) => {
    const original = originals[index];
    if (original) Object.defineProperty(HTMLElement.prototype, size, original);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the timeline filters, answered by the archive', () => {
  it('offer an agent that has no session on the loaded page', () => {
    view();
    const chips = screen.getByRole('group', { name: 'Filter by source' });
    expect(chips).toHaveTextContent('Antigravity CLI');
    // A source a machine is set up for but that has captured nothing is not offered.
    expect(chips).not.toHaveTextContent('Goose');
  });

  it('ask the archive for the chosen agent rather than filter the page', async () => {
    const listSessions = vi.spyOn(memoarApi, 'listSessions').mockResolvedValue({
      groups: [{ date: '2026-03-04', sessions: [older] }], total: 655, nextCursor: 'next',
    });
    view();

    fireEvent.click(screen.getByRole('button', { name: 'Antigravity CLI' }));

    await waitFor(() => expect(screen.getByText('Session ag-1')).toBeInTheDocument());
    expect(listSessions).toHaveBeenCalledWith({ agent: 'antigravity-cli' }, null);
    expect(screen.queryByText('Session cc-1')).not.toBeInTheDocument();
    expect(screen.getByText('655 matches')).toBeInTheDocument();
  });

  it('query the agent chosen in the sidebar on arrival', async () => {
    const load = vi.fn().mockResolvedValue({ groups: [{ date: '2026-03-04', sessions: [older] }], total: 655, nextCursor: null });
    view({ initialSource: 'antigravity-cli', loadFiltered: load });

    await waitFor(() => expect(screen.getByText('Session ag-1')).toBeInTheDocument());
    expect(load).toHaveBeenCalledWith({ agent: 'antigravity-cli' }, null);
    expect(screen.getByRole('button', { name: 'Antigravity CLI' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('send a chosen project as its full path', async () => {
    const load = vi.fn().mockResolvedValue({ groups: [], total: 0, nextCursor: null });
    view({ loadFiltered: load });

    fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: '/workspace/memoar' } });

    await waitFor(() => expect(load).toHaveBeenCalledWith({ workspace: '/workspace/memoar' }, null));
  });

  it('offer every project and agent the archive lists, not only those on the page', async () => {
    const loadFacets = vi.fn().mockResolvedValue({
      sources: [{ source: 'zed', sourceLabel: 'Zed', sessions: 4 }],
      workspaces: [{ path: '/work/old-project', sessions: 12, lastUpdatedAt: '2026-01-02T00:00:00.000Z' }],
    });
    const load = vi.fn().mockResolvedValue({ groups: [], total: 12, nextCursor: null });
    view({ loadFacets, loadFiltered: load });

    const projects = screen.getByLabelText('Filter by project');
    await waitFor(() => expect(projects).toHaveTextContent('old-project'));
    expect(projects, 'the loaded page still counts').toHaveTextContent('memoar');
    expect(screen.getByRole('group', { name: 'Filter by source' })).toHaveTextContent('Zed');

    fireEvent.change(projects, { target: { value: '/work/old-project' } });
    await waitFor(() => expect(load).toHaveBeenCalledWith({ workspace: '/work/old-project' }, null));
  });

  it('fall back to the page and the machines when the archive cannot list them', async () => {
    const loadFacets = vi.fn().mockRejectedValue(new Error('offline'));
    view({ loadFacets });
    await waitFor(() => expect(loadFacets).toHaveBeenCalled());
    expect(screen.getByRole('group', { name: 'Filter by source' })).toHaveTextContent('Antigravity CLI');
    expect(screen.getByLabelText('Filter by project')).toHaveTextContent('memoar');
  });
});

describe('the session list request', () => {
  it('carries the filter to /v1/sessions and groups the page by day', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [older], total: 655, nextCursor: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MemoarApiClient('https://archive.test/v1');

    const page = await client.listSessions({ agent: 'antigravity-cli' });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/v1/sessions');
    expect(url.searchParams.get('agent')).toBe('antigravity-cli');
    expect(page.total).toBe(655);
    expect(page.groups).toEqual([{ date: '2026-03-04', sessions: [expect.objectContaining({ id: 'ag-1' })] }]);
  });
});
