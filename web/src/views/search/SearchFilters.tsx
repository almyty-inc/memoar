import type { SearchResponse } from '../../lib/types';
import { cn } from '../../components/ui';
import { workspaceLabel } from '../../lib/workspace';

/*
  Only the facets the archive aggregates: agents and workspaces. A Date facet
  used to render "No values" for every query because no server sends dates.
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

/**
 * The facet rail. Each value is a row with its count; pressing it filters,
 * pressing it again takes the filter off. Below, what the search actually did,
 * as the server reports it, including why semantic search did not run.
 */
export function SearchFilters({ response, activeSource, setActiveSource, activeWorkspace, setActiveWorkspace }: {
  response: SearchResponse | null;
  activeSource: string | null;
  setActiveSource: (value: string | null) => void;
  activeWorkspace: string | null;
  setActiveWorkspace: (value: string | null) => void;
}) {
  if (!response) return null;
  const aggregations = response.aggregations ?? noAggregations;
  return (
    <aside className="facet-rail" aria-label="Search filters">
      <FacetGroup
        title="Source"
        items={aggregations.agents}
        activeValue={activeSource}
        onSelect={(value) => setActiveSource(activeSource === value ? null : value)}
      />
      <FacetGroup
        title="Project"
        mono
        items={aggregations.workspaces.map((item) => ({ ...item, label: workspaceLabel(item.value) }))}
        activeValue={activeWorkspace}
        onSelect={(value) => setActiveWorkspace(activeWorkspace === value ? null : value)}
      />
      <section className="facet-mode">
        <h2>{MODE_TITLES[response.meta.realizedMode]}</h2>
        <p>
          {MODE_EXPLANATIONS[response.meta.realizedMode]}
          {response.meta.semanticFailure ? ` Semantic search was unavailable: ${response.meta.semanticFailure}` : ''}
        </p>
      </section>
    </aside>
  );
}

function FacetGroup({ title, items, activeValue, onSelect, mono = false }: {
  title: string;
  items: SearchResponse['aggregations']['agents'];
  activeValue: string | null;
  onSelect: (value: string) => void;
  mono?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="facet-group">
      <h2>{title}</h2>
      {items.slice(0, 8).map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={activeValue === item.value}
          className={cn('facet', activeValue === item.value && 'active')}
          onClick={() => onSelect(item.value)}
        >
          <span className={cn('facet-label', mono && 'mono')}>{item.label}</span>
          <span className="facet-count">{item.count}</span>
        </button>
      ))}
    </section>
  );
}
