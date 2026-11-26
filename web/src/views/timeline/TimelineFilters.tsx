import { AgentDot } from '../../components/AgentMark';
import { Button, plural } from '../../components/ui';
import type { SessionSummary } from '../../lib/types';
import { workspaceLabel } from '../../lib/workspace';

export interface Filters {
  source: string;
  workspace: string;
  /** Days back, or 'all'. */
  within: string;
  /** Stamped when the range is chosen, so render never reads the clock. */
  cutoff: number | null;
}

export const NO_FILTERS: Filters = { source: 'all', workspace: 'all', within: 'all', cutoff: null };

const RANGES: Array<[string, string]> = [
  ['all', 'Any time'],
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
];

export function isFiltered(filters: Filters): boolean {
  return filters.source !== 'all' || filters.workspace !== 'all' || filters.within !== 'all';
}

export function matches(session: SessionSummary, filters: Filters): boolean {
  if (filters.source !== 'all' && session.source !== filters.source) return false;
  if (filters.workspace !== 'all' && session.workspace !== filters.workspace) return false;
  if (filters.cutoff === null) return true;
  const at = new Date(session.updatedAt).valueOf();
  return Number.isFinite(at) && at >= filters.cutoff;
}

/** A compact row of plain dropdowns, each with a name a screen reader can say. */
export function TimelineFilters({ sessions, filters, onChange, shown }: {
  sessions: SessionSummary[];
  filters: Filters;
  onChange: (filters: Filters) => void;
  /** How many rows the filters leave, when any filter is on. */
  shown: number | null;
}) {
  const knownSources = [...new Map(sessions.map((session) => [session.source, session.sourceLabel])).entries()];
  const workspaces = [...new Set(sessions.map((session) => session.workspace))].sort();

  const chooseRange = (value: string) => {
    const days = Number(value);
    onChange({ ...filters, within: value, cutoff: value === 'all' || !Number.isFinite(days) ? null : Date.now() - days * 24 * 60 * 60 * 1000 });
  };

  return (
    <section className="list-toolbar" aria-label="Session filters">
      {/* Pills with the agent's colour. The active one is solid ink. */}
      <div className="chips" role="group" aria-label="Filter by source">
        <button type="button" className="chip" aria-pressed={filters.source === 'all'} onClick={() => onChange({ ...filters, source: 'all' })}>All</button>
        {knownSources.map(([value, label]) => (
          <button key={value} type="button" className="chip" aria-pressed={filters.source === value} onClick={() => onChange({ ...filters, source: filters.source === value ? 'all' : value })}>
            <AgentDot source={value} />{label}
          </button>
        ))}
      </div>
      <label>
        <span className="sr-only">Filter by project</span>
        <select className="select-plain" value={filters.workspace} onChange={(event) => onChange({ ...filters, workspace: event.target.value })}>
          <option value="all">All projects</option>
          {workspaces.map((value) => <option key={value} value={value}>{workspaceLabel(value)}</option>)}
        </select>
      </label>
      <label>
        <span className="sr-only">Filter by date</span>
        <select className="select-plain" value={filters.within} onChange={(event) => chooseRange(event.target.value)}>
          {RANGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {isFiltered(filters) ? (
        <>
          <span className="meta">{plural(shown ?? 0, 'match', 'matches')}</span>
          <Button size="sm" variant="ghost" onClick={() => onChange(NO_FILTERS)}>Clear</Button>
        </>
      ) : null}
    </section>
  );
}
