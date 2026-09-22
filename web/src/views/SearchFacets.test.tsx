import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchView } from './Search';
import { memoarApi } from '../lib/api';
import type { SearchResponse, SessionSummary } from '../lib/types';

function session(id: string, workspace: string, sourceLabel: string): SessionSummary {
  return {
    id, title: `Work in ${workspace}`, summary: 'A session',
    source: 'claude-code', sourceLabel, workspace, branch: 'main',
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    turnCount: 4, tokenCount: 0, durationMinutes: 0, redactionStatus: 'clear',
  };
}

const ITEMS = [
  session('s-1', '/w/memoar', 'Claude Code'),
  session('s-2', '/w/almyty', 'Claude Code'),
  session('s-3', '/w/memoar', 'Codex'),
];

function results(): SearchResponse {
  return {
    items: ITEMS,
    nextCursor: null,
    aggregations: {
      // mapAggregation sets value and label to the same string, so a fixture
      // where they differ would test a shape the client never produces.
      agents: [
        { value: 'Claude Code', label: 'Claude Code', count: 2 },
        { value: 'Codex', label: 'Codex', count: 1 },
      ],
      workspaces: [
        { value: '/w/memoar', label: '/w/memoar', count: 2 },
        { value: '/w/almyty', label: '/w/almyty', count: 1 },
      ],
    },
    meta: { requestedMode: 'hybrid', realizedMode: 'hybrid', tookMs: 12, semanticFailure: null },
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

async function search(): Promise<ReturnType<typeof userEvent.setup>> {
  vi.spyOn(memoarApi, 'search').mockResolvedValue(results());
  const user = userEvent.setup();
  render(<SearchView onOpen={vi.fn()} />);
  await user.type(screen.getByRole('searchbox'), 'archive');
  await waitFor(() => expect(screen.getByText('3 results')).toBeInTheDocument());
  return user;
}

/** The facet rows, as distinct from the same workspace named on a result card. */
function facet(name: RegExp): HTMLElement {
  return within(screen.getByRole('complementary', { name: 'Search filters' }))
    .getByRole('button', { name });
}

/**
 * The filter panel rendered every facet row as a `<button>`, but only the
 * Source group was given an `onSelect`. Workspace rows were therefore
 * focusable, announced to a screen reader as buttons, and did nothing at all
 * when pressed — an affordance offered and not honoured. Nothing caught it
 * because no test had ever pressed one.
 */
describe('the workspace facet', () => {
  it('narrows the results to the workspace that was pressed', async () => {
    const user = await search();
    expect(screen.getByText('3 results')).toBeInTheDocument();

    await user.click(facet(/\/w\/memoar/));

    await waitFor(() => expect(screen.getByText('2 results')).toBeInTheDocument());
    expect(screen.queryByText('Work in /w/almyty')).not.toBeInTheDocument();
  });

  it('lets the filter be seen and taken off again', async () => {
    const user = await search();
    await user.click(facet(/\/w\/almyty/));
    await waitFor(() => expect(screen.getByText('1 result')).toBeInTheDocument());

    // The chip naming the active filter is how it is removed; without one the
    // only way back is to retype the query.
    const active = screen.getByRole('group', { name: 'Active filters' });
    await user.click(within(active).getByRole('button', { name: /\/w\/almyty/ }));

    await waitFor(() => expect(screen.getByText('3 results')).toBeInTheDocument());
  });

  it('combines with the source filter rather than replacing it', async () => {
    const user = await search();
    await user.click(facet(/\/w\/memoar/));
    await user.click(facet(/Codex/));

    await waitFor(() => expect(screen.getByText('1 result')).toBeInTheDocument());
    expect(screen.getByText('Work in /w/memoar')).toBeInTheDocument();
  });
});

/**
 * The panel declared a Date group and read `aggregations.dates`. No archive has
 * ever sent that key — the server aggregates agents and workspaces — and the
 * wire type is an open record, so the two sides were never compared. Every
 * query, on every archive, drew a Date heading above "No values".
 */
describe('the filter panel', () => {
  it('offers no facet the archive cannot fill', async () => {
    await search();
    expect(screen.queryByRole('heading', { name: /Date/ })).not.toBeInTheDocument();
    expect(screen.queryByText('No values')).not.toBeInTheDocument();
  });
});
