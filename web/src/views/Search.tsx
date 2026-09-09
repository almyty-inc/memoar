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

const emptyResponse: SearchResponse = {
  items: [],
  nextCursor: null,
  aggregations: { agents: [], workspaces: [], dates: [] },
  meta: { requestedMode: 'hybrid', realizedMode: 'hybrid', tookMs: 0, semanticFailure: null },
};

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

export function SearchView({ onOpen }: { onOpen: (session: SessionSummary) => void }) {
  const [query, setQuery] = useState('parser');
  const [response, setResponse] = useState<SearchResponse>(emptyResponse);
  const [loading, setLoading] = useState(true);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<'relevance' | 'recent'>('relevance');
  const [packOpen, setPackOpen] = useState(false);
  const [pack, setPack] = useState<PackResponse | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoading(true);
      void memoarApi.search(query).then((result) => {
        setResponse(result);
        setLoading(false);
      });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [query]);

  const items = useMemo(() => {
    const filtered = response.items.filter((session) => !activeSource || session.sourceLabel === activeSource);
    // The server orders by relevance already, so 'relevance' keeps its order
    // rather than re-sorting on a score the backend may not have supplied.
    if (sort === 'relevance') return filtered;
    return [...filtered].sort((left, right) => new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf());
  }, [activeSource, response.items, sort]);

  const previewPack = async () => {
    setPackOpen(true);
    setPackLoading(true);
    setPackError(null);
    try {
      setPack(await memoarApi.buildPack(query, 4000, 'mixed'));
    } catch (error) {
      setPackError(error instanceof Error ? error.message : 'Pack request failed');
    } finally {
      setPackLoading(false);
    }
  };

  const clearQuery = () => {
    setQuery('');
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
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Try “how did we fix tenant isolation?”"
            aria-label="Search sessions"
          />
          {query ? <button type="button" onClick={clearQuery} aria-label="Clear search"><X size={17} /></button> : null}
          <kbd><Command size={11} /> K</kbd>
        </div>
        <div className="search-suggestions">
          <span>Try</span>
          {['redaction review', 'parent reference', 'pack freshness'].map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => setQuery(suggestion)}>{suggestion}</button>
          ))}
        </div>
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
            items={response.aggregations.agents}
            activeValue={activeSource}
            onSelect={(value) => setActiveSource(activeSource === value ? null : value)}
          />
          <AggregationGroup icon={<FolderGit2 size={14} />} title="Workspace" items={response.aggregations.workspaces} />
          <AggregationGroup icon={<Calendar size={14} />} title="Date" items={response.aggregations.dates} />
          {/*
            What the search actually did, which the server reports. This card
            said "Hybrid mode — lexical and semantic results are fused with RRF"
            whatever ran: a deployment with no embedding provider falls back to
            lexical, and the panel went on describing a fusion that had not
            happened.
          */}
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
        </aside>

        <section className="search-results" aria-busy={loading}>
          <div className="results-toolbar">
            <div>
              <Button className="show-filters" size="sm" onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={14} /> Filters</Button>
              <strong>{loading ? 'Searching…' : `${items.length} result${items.length === 1 ? '' : 's'}`}</strong>
              {!loading && query ? <span>for “{query}”</span> : null}
            </div>
            <div className="results-meta">
              <span>{response.meta.realizedMode} · {response.meta.tookMs} ms</span>
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
                      <span>{session.workspace}</span>
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
            {!loading && items.length === 0 ? (
              <EmptyState
                title="No matching sessions"
                body="Try a broader phrase or clear the source filter. Lexical search remains available if semantic retrieval is offline."
                action={<Button onClick={() => { clearQuery(); setActiveSource(null); }}>Clear search</Button>}
              />
            ) : null}
            {loading ? Array.from({ length: 3 }, (_, index) => <div className="result-skeleton" key={index} />) : null}
          </div>

          {!loading && items.length > 0 ? (
            <div className="pack-prompt">
              <span className="pack-icon"><Braces size={18} /></span>
              <div><strong>Turn these results into a cited context pack</strong><p>Preview evidence within a 4,000-token budget before sending it to an agent.</p></div>
              <Button variant="primary" disabled={packLoading} onClick={() => void previewPack()}>Preview pack <ArrowRight size={14} /></Button>
            </div>
          ) : null}
        </section>
      </div>

      <Modal open={packOpen} title="Pack preview" description="A cited, extractive bundle built from these results." onClose={() => setPackOpen(false)}>
        <div className="modal-body pack-modal-body">
          {packLoading ? <p role="status">Building cited preview…</p> : null}
          {packError ? <p role="alert">{packError}</p> : null}
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
