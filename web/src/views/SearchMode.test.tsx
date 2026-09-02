import { render, screen, waitFor } from '@testing-library/react';
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

describe('what the search actually did', () => {
  it('describes a fusion only when one happened', async () => {
    vi.spyOn(memoarApi, 'search').mockResolvedValue(response({ realizedMode: 'hybrid' }));

    render(<SearchView onOpen={vi.fn()} />);

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

    await waitFor(() => expect(screen.getByText('Lexical mode')).toBeInTheDocument());
    expect(screen.getByText(/Ranked by matching words alone/)).toBeInTheDocument();
    expect(screen.getByText(/no embedding provider configured/)).toBeInTheDocument();
    expect(screen.queryByText(/reciprocal rank/)).not.toBeInTheDocument();
  });
});
