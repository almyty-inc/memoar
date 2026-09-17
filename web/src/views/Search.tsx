import {
  ArrowRight,
  Bot,
  Braces,
  Calendar,
  ChevronDown,
  CircleGauge,
  Command,
  FolderGit2,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { memoarApi } from '../lib/api';
import { DEFAULT_PACK_TOKEN_BUDGET, formatTokenBudget } from '../lib/limits';
import type { PackResponse, SearchResponse, SessionSummary } from '../lib/types';

import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  Modal,
  HighlightText,
  RedactionBadge,
  SourceBadge,
  cn,
  formatRelative,
} from '../components/ui';

const noAggregations: SearchResponse['aggregations'] = { agents: [], workspaces: [], dates: [] };


const MODE_TITLES: Record<SearchResponse['meta']['realizedMode'], string> = {
  hybrid: 'Hybrid mode',
  lexical: 'Lexical mode',
  semantic: 'Semantic mode',
};

const MODE_EXPLANATIONS: Record<SearchResponse['meta']['realizedMode'], string> = {
  hybrid: 'Lexical and semantic results, fused by reciprocal rank.',
  lexical: 'Ranked by matching words alone.',
  semantic: 'Ranked by meaning alone.',
};

export function SearchView({ onOpen, workspaces = [] }: {
  onOpen: (session: SessionSummary) => void;
  /** The account's own workspaces, for starting points that are not invented. */
  workspaces?: string[];
}) {
  // Empty. This opened with `parser` already typed and executed, so the page
  // presented a developer's test query and its results as if you had searched.
  const [query, setQuery] = useState('');
  /*
    Null until a query has actually been sent. It used to start as a zeroed
    SearchResponse and the page reported it: "0 results", "hybrid · 12 ms", and
    "No matching sessions — try a broader phrase or clear the source filter",
    for a search nobody had run and a filter nobody had set. A count, a mode
    and a duration are findings, so they exist only once there is a search to
    have found them.
  */
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<'relevance' | 'recent'>('relevance');
  const [packOpen, setPackOpen] = useState(false);
  const [pack, setPack] = useState<PackResponse | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
    Nothing is asked of the archive until there is something to ask. An empty
    box is not a query, and a rejected query is a state the page has to be able
    to show: without the catch below, one failed request left `loading` true,
    `aria-busy` on, and three skeletons shimmering for as long as the tab was
    open.
  */
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
    const filtered = (response?.items ?? []).filter((session) => !activeSource || session.sourceLabel === activeSource);

    // The server orders by relevance already, so 'relevance' keeps its order
    // rather than re-sorting on a score the backend may not have supplied.
    if (sort === 'relevance') return filtered;
    return [...filtered].sort((left, right) => new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf());
  }, [activeSource, response, sort]);


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

  /*
    Emptying the box puts the page back to before any search, now rather than
    a debounce later. It belongs to the event that emptied it: an effect that
    sets state as soon as it runs re-renders for nothing.
  */
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
      <section className="search-hero">
        <div className="eyebrow"><Sparkles size={13} /> Hybrid retrieval across your archive</div>
        <h1>Find the work, not the window.</h1>
        <div className="big-search">
          <Search size={21} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => updateQuery(event.target.value)}

            placeholder="Try “how did we fix tenant isolation?”"
            aria-label="Search sessions"
          />
          {query ? <button type="button" onClick={clearQuery} aria-label="Clear search"><X size={17} /></button> : null}
          <kbd><Command size={11} /> K</kbd>
        </div>
        {/* The three suggestions here — "redaction review", "parent reference",
            "pack freshness" — were fixed strings from a developer's test corpus,
            offered as if they had come from your archive. Your own workspaces
            are real, and they are what you would actually search within. */}
        {workspaces.length > 0 ? (
          <div className="search-suggestions">
            <span>In</span>
            {workspaces.slice(0, 4).map((workspace) => (
              <button key={workspace} type="button" onClick={() => updateQuery(workspace)}>{workspace}</button>

            ))}
          </div>
        ) : null}
      </section>

      <div className="search-layout">
        <aside className={cn('aggregation-sidebar', filtersOpen && 'aggregation-open')} aria-label="Search filters">
          <div className="aggregation-mobile-head">
            <strong>Filter results</strong>
            <Button size="sm" variant="ghost" onClick={() => setFiltersOpen(false)}><X size={14} /> Close</Button>
          </div>
          <AggregationGroup
            icon={<Bot size={14} />}
            title="Source"
            items={(response?.aggregations ?? noAggregations).agents}
            activeValue={activeSource}
            onSelect={(value) => setActiveSource(activeSource === value ? null : value)}
          />
          <AggregationGroup icon={<FolderGit2 size={14} />} title="Workspace" items={(response?.aggregations ?? noAggregations).workspaces} />
          <AggregationGroup icon={<Calendar size={14} />} title="Date" items={(response?.aggregations ?? noAggregations).dates} />

          {/*
            What the search actually did, which the server reports. This card
            said "Hybrid mode — lexical and semantic results are fused with RRF"
            whatever ran: a deployment with no embedding provider falls back to
            lexical, and the panel went on describing a fusion that had not
            happened.
          */}
          {response ? (
            <div className="search-mode-card">
              <CircleGauge size={17} />
              <div>
                <strong>{MODE_TITLES[response.meta.realizedMode]}</strong>
                <p>
                  {MODE_EXPLANATIONS[response.meta.realizedMode]}
                  {response.meta.semanticFailure
                    ? ` Semantic search was unavailable: ${response.meta.semanticFailure}`
                    : ''}
                </p>
              </div>
            </div>
          ) : null}

        </aside>

        <section className="search-results" aria-busy={loading}>
          <div className="results-toolbar">
            <div>
              <Button className="show-filters" size="sm" onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={14} /> Filters</Button>
              {/* A count is a finding. Before there is one, the toolbar says
                  nothing rather than saying zero. */}
              {loading || response ? (
                <strong>{loading ? 'Searching…' : `${items.length} result${items.length === 1 ? '' : 's'}`}</strong>
              ) : null}

              {!loading && response ? <span>for “{query.trim()}”</span> : null}
            </div>
            <div className="results-meta">
              {response ? <span>{response.meta.realizedMode} · {response.meta.tookMs} ms</span> : null}

              <label className="select-control">
                <select value={sort} onChange={(event) => setSort(event.target.value === 'recent' ? 'recent' : 'relevance')}>
                  <option value="relevance">Best match</option>
                  <option value="recent">Most recent</option>
                </select>
                <ChevronDown size={13} />
              </label>
            </div>
          </div>

          <div className="active-filter-row">
            {activeSource ? (
              <button type="button" onClick={() => setActiveSource(null)}>{activeSource} <X size={12} /></button>
            ) : null}
          </div>

          <div className="results-list" aria-live="polite">
            {!loading && items.map((session, index) => (
              <article className="search-result-card" key={session.id}>
                <button type="button" onClick={() => onOpen(session)} className="search-result-button">
                  <div className="result-score" title="Hybrid relevance score">
                    <span>{Math.round((session.score ?? 0.9) * 100)}</span>
                    <small>match</small>
                  </div>
                  <div className="result-content">
                    <div className="result-topline">
                      <SourceBadge source={session.source} label={session.sourceLabel} />
                      <span className="session-path">{session.workspace}</span>
                      <span>·</span>
                      <span>{formatRelative(session.updatedAt)}</span>
                    </div>
                    <h2><HighlightText text={session.title} query={query} /></h2>
                    <p><HighlightText text={session.highlight ?? session.summary} query={query} /></p>
                    <div className="result-foot">
                      <RedactionBadge status={session.redactionStatus} />

                      <span>{session.turnCount} turns</span>
                      <span className="result-open">Open session <ArrowRight size={13} /></span>
                    </div>
                  </div>
                </button>
                {index === 0 ? <div className="best-result-marker"><Sparkles size={12} /> Best match</div> : null}
              </article>
            ))}
            {searchError ? <p role="alert" className="error-note">{searchError}</p> : null}
            {!loading && !searchError && response && items.length === 0 ? (
              <EmptyState
                title="No matching sessions"
                body={activeSource
                  ? 'Try a broader phrase, or clear the source filter. Lexical search remains available if semantic retrieval is offline.'
                  : 'Try a broader phrase. Lexical search remains available if semantic retrieval is offline.'}
                action={<Button onClick={() => { clearQuery(); setActiveSource(null); }}>Clear search</Button>}
              />
            ) : null}
            {/* Before a query, the page says what it is for rather than
                reporting on a search that has not happened. */}
            {!loading && !searchError && !response ? (
              <EmptyState
                title="Search your archive"
                body="Type a phrase and every captured session is searched — by matching words, and by meaning where this archive has embeddings."
              />
            ) : null}
            {loading ? Array.from({ length: 3 }, (_, index) => <div className="result-skeleton" key={index} />) : null}
          </div>

          {!loading && items.length > 0 ? (
            <div className="pack-prompt">
              <span className="pack-icon"><Braces size={18} /></span>
              <div><strong>Turn these results into a cited context pack</strong><p>Preview evidence within a {formatTokenBudget(DEFAULT_PACK_TOKEN_BUDGET)}-token budget before sending it to an agent.</p>
</div>

              <Button variant="primary" disabled={packLoading} onClick={() => void previewPack()}>Preview pack <ArrowRight size={14} /></Button>
            </div>
          ) : null}
        </section>
      </div>

      <Modal open={packOpen} title="Pack preview" description="A cited, extractive bundle built from these results." onClose={() => setPackOpen(false)}>
        <div className="modal-body pack-modal-body">
          {packLoading ? <p role="status">Building cited preview…</p> : null}
          {packError ? <p role="alert" className="error-note">{packError}</p> : null}

          {pack ? (
            <div className="pack-preview-card">
              <div><Badge>{pack.evidence.length} excerpts</Badge><span>Estimated {pack.tokenEstimate.toLocaleString()} tokens</span></div>
              <h3>{pack.query}</h3>
              <p>{pack.evidence[0]?.excerpt ?? 'No evidence matched this query.'}</p>
            </div>
          ) : null}
        </div>
        <footer className="modal-actions">
          {pack ? <CopyButton value={pack.markdown} label="Copy pack" /> : null}
          <Button variant="ghost" onClick={() => setPackOpen(false)}>Close</Button>
        </footer>
      </Modal>
    </div>
  );
}

function AggregationGroup({ icon, title, items, activeValue, onSelect }: {
  icon: React.ReactNode;
  title: string;
  items: SearchResponse['aggregations']['agents'];
  activeValue?: string | null;
  onSelect?: (value: string) => void;
}) {
  return (
    <section className="aggregation-group">
      <h2>{icon}{title}</h2>
      {items.slice(0, 6).map((item) => (
        <button
          key={item.value}
          type="button"
          className={cn(activeValue === item.value && 'active')}
          onClick={() => onSelect?.(item.value)}
        >
          <span>{item.label}</span><small>{item.count}</small>
        </button>
      ))}
      {!items.length ? <p className="muted-small">No values</p> : null}
    </section>
  );
}
