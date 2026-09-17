import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchView } from './Search';
import { memoarApi } from '../lib/api';
import type { SearchResponse } from '../lib/types';

function response(meta: Partial<SearchResponse['meta']>): SearchResponse {
  return {
    items: [],
    nextCursor: null,
    aggregations: { agents: [], workspaces: [], dates: [] },
    meta: { requestedMode: 'hybrid', realizedMode: 'hybrid', tookMs: 4, semanticFailure: null, ...meta },
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

/** The panel reports on a search, so there has to be one to report on. */
async function searchFor(phrase: string): Promise<void> {
  await userEvent.type(screen.getByLabelText('Search sessions'), phrase);
}

describe('what the search actually did', () => {
  it('describes a fusion only when one happened', async () => {
    vi.spyOn(memoarApi, 'search').mockResolvedValue(response({ realizedMode: 'hybrid' }));

    render(<SearchView onOpen={vi.fn()} />);
    await searchFor('tenant isolation');

    expect(await screen.findByText('Hybrid mode')).toBeInTheDocument();
    expect(screen.getByText(/fused by reciprocal rank/)).toBeInTheDocument();
  });


  it('says lexical when semantic search did not run, and why', async () => {
    // This panel claimed "Lexical and semantic results are fused with RRF"
    // whatever ran, so a deployment with no embedding provider described a
    // fusion that never happened.
    vi.spyOn(memoarApi, 'search').mockResolvedValue(response({
      requestedMode: 'hybrid',
      realizedMode: 'lexical',
      semanticFailure: 'no embedding provider configured',
    }));

    render(<SearchView onOpen={vi.fn()} />);
    await searchFor('tenant isolation');

    await waitFor(() => expect(screen.getByText('Lexical mode')).toBeInTheDocument());

    expect(screen.getByText(/Ranked by matching words alone/)).toBeInTheDocument();
    expect(screen.getByText(/no embedding provider configured/)).toBeInTheDocument();
    expect(screen.queryByText(/reciprocal rank/)).not.toBeInTheDocument();
  });
});
