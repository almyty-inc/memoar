import { Bot, CircleGauge, FolderGit2, X } from 'lucide-react';
import type { SearchResponse } from '../../lib/types';
import { Button, cn } from '../../components/ui';

/*
  There was a third group here, "Date". The archive has never sent a `dates`
  aggregation — it sends `agents` and `workspaces` — and the wire type is an
  open record, so nothing compared the two sides. The panel rendered a Date
  heading above "No values" for every query on every archive, permanently. A
  facet that cannot populate is worse than an absent one: it reads as "this
  archive has no dates".
*/
const noAggregations: SearchResponse['aggregations'] = { agents: [], workspaces: [] };


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

export function SearchFilters({ filtersOpen, setFiltersOpen, response, activeSource, setActiveSource, activeWorkspace, setActiveWorkspace }: {
  filtersOpen: boolean;
  setFiltersOpen: (open: boolean) => void;
  response: SearchResponse | null;
  activeSource: string | null;
  setActiveSource: (value: string | null) => void;
  activeWorkspace: string | null;
  setActiveWorkspace: (value: string | null) => void;
}) {
  return (
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
      {/*
        Workspace rows were rendered as buttons with no handler: focusable,
        announced as buttons, and doing nothing when pressed. They now filter
        the way Source does.
      */}
      <AggregationGroup
        icon={<FolderGit2 size={14} />}
        title="Workspace"
        items={(response?.aggregations ?? noAggregations).workspaces}
        activeValue={activeWorkspace}
        onSelect={(value) => setActiveWorkspace(activeWorkspace === value ? null : value)}
      />

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
