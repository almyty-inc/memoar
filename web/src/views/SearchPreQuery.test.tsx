import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchView } from './Search';
import { memoarApi } from '../lib/api';
import { DEFAULT_PACK_TOKEN_BUDGET } from '../lib/limits';
import type { SearchResponse, SessionSummary } from '../lib/types';

function session(): SessionSummary {
  return {
    id: 's-1', title: 'Tenant isolation', summary: 'How the archive scopes a query',
    source: 'claude-code', sourceLabel: 'Claude Code', workspace: '/w/memoar', branch: 'main',
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    turnCount: 4, tokenCount: 0, durationMinutes: 0, redactionStatus: 'clear',
  };
}

function results(items: SessionSummary[]): SearchResponse {
  return {
    items,
    nextCursor: null,
    aggregations: { agents: [], workspaces: [], dates: [] },
    meta: { requestedMode: 'hybrid', realizedMode: 'hybrid', tookMs: 12, semanticFailure: null },
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('search before anybody has searched', () => {
  it('asks the archive nothing', async () => {
    // This fired memoarApi.search('') 140ms after mount.
    const search = vi.spyOn(memoarApi, 'search').mockResolvedValue(results([]));

    render(<SearchView onOpen={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(search).not.toHaveBeenCalled();
  });

  it('reports no count, no mode and no timing for a search nobody ran', async () => {
    vi.spyOn(memoarApi, 'search').mockResolvedValue(results([]));

    render(<SearchView onOpen={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // "0 results · hybrid · 12 ms" — three findings about nothing.
    expect(screen.queryByText('0 results')).not.toBeInTheDocument();
    expect(screen.queryByText(/hybrid · \d+ ms/u)).not.toBeInTheDocument();
    expect(screen.queryByText('Hybrid mode')).not.toBeInTheDocument();
    // And no "try a broader phrase or clear the source filter" when there is
    // neither a phrase nor a filter.
    expect(screen.queryByText('No matching sessions')).not.toBeInTheDocument();
    expect(screen.getByText('Search your archive')).toBeInTheDocument();
  });

  it('reports them once a real query has run', async () => {
    const search = vi.spyOn(memoarApi, 'search').mockResolvedValue(results([]));

    render(<SearchView onOpen={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Search sessions'), 'tenant isolation');

    expect(await screen.findByText('0 results')).toBeInTheDocument();
    expect(screen.getByText('hybrid · 12 ms')).toBeInTheDocument();
    expect(screen.getByText('No matching sessions')).toBeInTheDocument();
    expect(search).toHaveBeenCalledWith('tenant isolation');
  });


  it('stops spinning when the archive refuses, and says why', async () => {
    // Without a .catch, `loading` stayed true: aria-busy on and three
    // skeletons shimmering for as long as the tab was open.
    vi.spyOn(memoarApi, 'search').mockRejectedValue(new Error('search index unavailable'));

    const { container } = render(<SearchView onOpen={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Search sessions'), 'tenant isolation');

    expect(await screen.findByRole('alert')).toHaveTextContent('search index unavailable');
    await waitFor(() => expect(container.querySelector('.search-results')).toHaveAttribute('aria-busy', 'false'));
    expect(container.querySelectorAll('.result-skeleton')).toHaveLength(0);
  });
});

/*
  The context budget was three separate literals: this copy, the request this
  screen sends, and the default on the session pack control. Mocking the one
  constant they now share is what tells them apart from three coincidences.
*/
vi.mock('../lib/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/limits')>()),
  DEFAULT_PACK_TOKEN_BUDGET: 8500,
}));

describe('the context budget', () => {
  it('quotes the same number it sends', async () => {
    vi.spyOn(memoarApi, 'search').mockResolvedValue(results([session()]));
    const buildPack = vi.spyOn(memoarApi, 'buildPack').mockRejectedValue(new Error('no pack'));

    render(<SearchView onOpen={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Search sessions'), 'tenant isolation');

    expect(await screen.findByText(/8,500-token budget/u)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Preview pack/u }));
    await waitFor(() => expect(buildPack).toHaveBeenCalledWith('tenant isolation', DEFAULT_PACK_TOKEN_BUDGET, 'mixed'));
    expect(DEFAULT_PACK_TOKEN_BUDGET).toBe(8500);
  });
});
