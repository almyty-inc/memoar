import { Search as SearchIcon, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, PageHeader, plural } from '../components/ui';
import { memoarApi } from '../lib/api';
import { DEFAULT_PACK_TOKEN_BUDGET, formatTokenBudget } from '../lib/limits';
import type { PackResponse, SearchResponse, SessionSummary } from '../lib/types';
import { PackPreviewModal } from './search/PackPreviewModal';
import { SearchFilters } from './search/SearchFilters';
import { SearchResults } from './search/SearchResults';

export function SearchView({ onOpen, workspaces = [], initialQuery = '' }: {
  onOpen: (session: SessionSummary) => void;
  /** The account's own workspaces, offered as starting points. */
  workspaces?: string[];
  /** What the command palette was asked to search for. */
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  /*
    Null until a query has been sent. A count, a mode and a duration are
    findings, so they exist only once there is a search to have found them.
  */
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [sort, setSort] = useState<'relevance' | 'recent'>('relevance');
  const [packOpen, setPackOpen] = useState(false);
  const [pack, setPack] = useState<PackResponse | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Nothing is asked until there is something to ask, and a refusal ends the
  // loading state rather than leaving skeletons up for good.
  useEffect(() => {
    const phrase = query.trim();
    if (!phrase) return undefined;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setSearchError(null);
      void memoarApi.search(phrase).then((result) => {
        if (!active) return;
        setResponse(result);
        setLoading(false);
      }).catch((error: unknown) => {
        if (!active) return;
        setResponse(null);
        setSearchError(error instanceof Error ? error.message : 'Search failed');
        setLoading(false);
      });
    }, 140);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query]);

  const items = useMemo(() => {
    const filtered = (response?.items ?? []).filter((session) => (
      (!activeSource || session.sourceLabel === activeSource)
      && (!activeWorkspace || session.workspace === activeWorkspace)
    ));
    // The server already orders by relevance.
    if (sort === 'relevance') return filtered;
    return [...filtered].sort((left, right) => new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf());
  }, [activeSource, activeWorkspace, response, sort]);

  const previewPack = async () => {
    setPackOpen(true);
    setPackLoading(true);
    setPackError(null);
    try {
      setPack(await memoarApi.buildPack(query, DEFAULT_PACK_TOKEN_BUDGET, 'mixed'));
    } catch (error) {
      setPackError(error instanceof Error ? error.message : 'Pack request failed');
    } finally {
      setPackLoading(false);
    }
  };

  // Emptying the box puts the page back to before any search, immediately.
  const updateQuery = (value: string) => {
    setQuery(value);
    if (value.trim()) return;
    setResponse(null);
    setSearchError(null);
    setLoading(false);
  };

  const clearQuery = () => {
    updateQuery('');
    inputRef.current?.focus();
  };

  return (
    <div className="page search-page">
      <PageHeader title="Search" />
      <div className="search-box">
        <SearchIcon size={15} aria-hidden="true" />
        <input
          id="search-input"
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); document.querySelector<HTMLElement>('.result-row')?.focus(); } }}
          placeholder="Search every transcript"
          aria-label="Search sessions"
        />
        {query ? <button type="button" className="icon-button" onClick={clearQuery} aria-label="Clear search"><X size={14} /></button> : null}
      </div>

      {!response && !loading && !searchError && workspaces.length > 0 ? (
        <p className="search-starts">
          <span>Projects</span>
          {workspaces.slice(0, 5).map((workspace) => (
            <button key={workspace} type="button" className="link-button mono" onClick={() => updateQuery(workspace)}>{workspace}</button>
          ))}
        </p>
      ) : null}

      <div className="search-layout">
        <section className="search-results" aria-busy={loading}>
          {loading || response ? (
            <div className="results-toolbar">
              <strong>{loading ? 'Searching' : plural(items.length, 'result')}</strong>
              {response && !loading ? <span className="results-meta">{response.meta.realizedMode} · {response.meta.tookMs} ms</span> : null}
              <div role="group" aria-label="Active filters" className="active-filters">
                {activeSource ? <button type="button" className="chip" onClick={() => setActiveSource(null)}>{activeSource} <X size={11} aria-hidden="true" /></button> : null}
                {activeWorkspace ? <button type="button" className="chip mono" onClick={() => setActiveWorkspace(null)}>{activeWorkspace} <X size={11} aria-hidden="true" /></button> : null}
              </div>
              <label className="sort-control">
                <span className="sr-only">Sort results</span>
                <select className="select-plain" value={sort} onChange={(event) => setSort(event.target.value === 'recent' ? 'recent' : 'relevance')}>
                  <option value="relevance">Best match</option>
                  <option value="recent">Most recent</option>
                </select>
              </label>
            </div>
          ) : null}

          <div aria-live="polite">
            {searchError ? <p role="alert" className="error-note">{searchError}</p> : null}
            {loading ? Array.from({ length: 4 }, (_, index) => (
              <div className="result-skeleton" key={index}><span className="skeleton" style={{ width: '48%' }} /><span className="skeleton" style={{ width: '78%' }} /></div>
            )) : null}
            {!loading && items.length > 0 ? <SearchResults items={items} query={query} onOpen={onOpen} /> : null}
            {!loading && !searchError && response && items.length === 0 ? (
              <EmptyState
                title="No matching sessions"
                body={activeSource || activeWorkspace ? 'Try a broader phrase, or clear the filters.' : 'Try a broader phrase.'}
                action={<Button size="sm" onClick={() => { clearQuery(); setActiveSource(null); setActiveWorkspace(null); }}>Clear search</Button>}
              />
            ) : null}
            {!loading && !searchError && !response ? (
              <EmptyState title="Search your archive" body="Matches words in every captured session, and meaning where this archive has embeddings." />
            ) : null}
          </div>

          {!loading && items.length > 0 ? (
            <div className="notice pack-prompt">
              <p>Build a cited context pack from these results, within a {formatTokenBudget(DEFAULT_PACK_TOKEN_BUDGET)}-token budget.</p>
              <Button size="sm" disabled={packLoading} onClick={() => void previewPack()}>Preview pack</Button>
            </div>
          ) : null}
        </section>

        <SearchFilters
          response={response}
          activeSource={activeSource}
          setActiveSource={setActiveSource}
          activeWorkspace={activeWorkspace}
          setActiveWorkspace={setActiveWorkspace}
        />
      </div>

      <PackPreviewModal packOpen={packOpen} setPackOpen={setPackOpen} packLoading={packLoading} packError={packError} pack={pack} />
    </div>
  );
}
