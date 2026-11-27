import { AgentDot } from '../../components/AgentMark';
import { Button, plural } from '../../components/ui';
import { sourceLabel } from '../../lib/source-labels';
import type { Machine, SessionSummary } from '../../lib/types';
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

/**
 * Every agent the archive holds sessions from, not only those on the page.
 *
 * The machines list counts sessions per source for the whole archive, so an
 * agent whose sessions are all older than the loaded page is still offered.
 * Sessions already loaded add sources no machine reports, such as imports.
 */
export function sourceOptions(machines: Machine[], sessions: SessionSummary[], chosen: string): Array<[string, string]> {
  const options = new Map<string, string>();
  for (const machine of machines) {
    for (const source of machine.sources) {
      if (source.sessionCount > 0 && !options.has(source.id)) options.set(source.id, sourceLabel(source.id));
    }
  }
  for (const session of sessions) {
    if (!options.has(session.source)) options.set(session.source, session.sourceLabel);
  }
  if (chosen !== 'all' && !options.has(chosen)) options.set(chosen, sourceLabel(chosen));
  return [...options].sort(([, left], [, right]) => left.localeCompare(right));
}

/**
 * The projects among the sessions loaded so far, plus the one chosen.
 *
 * No endpoint lists an archive's projects, so this list can miss a project
 * whose sessions are all older than the loaded page. A project that is chosen
 * is still queried from the archive, never matched against the page.
 */
export function workspaceOptions(sessions: SessionSummary[], chosen: string): string[] {
  const workspaces = new Set(sessions.map((session) => session.workspace));
  if (chosen !== 'all') workspaces.add(chosen);
  return [...workspaces].sort();
}

/** A compact row of plain dropdowns, each with a name a screen reader can say. */
export function TimelineFilters({ sources, workspaces, filters, onChange, shown }: {
  sources: Array<[string, string]>;
  workspaces: string[];
  filters: Filters;
  onChange: (filters: Filters) => void;
  /** How many sessions the archive says match, once it has answered. */
  shown: number | null;
}) {

  const chooseRange = (value: string) => {
    const days = Number(value);
    onChange({ ...filters, within: value, cutoff: value === 'all' || !Number.isFinite(days) ? null : Date.now() - days * 24 * 60 * 60 * 1000 });
  };

  return (
    <section className="list-toolbar" aria-label="Session filters">
      {/* Pills with the agent's colour. The active one is solid ink. */}
      <div className="chips" role="group" aria-label="Filter by source">
        <button type="button" className="chip" aria-pressed={filters.source === 'all'} onClick={() => onChange({ ...filters, source: 'all' })}>All</button>
        {sources.map(([value, label]) => (
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
          {shown === null ? null : <span className="meta">{plural(shown, 'match', 'matches')}</span>}
          <Button size="sm" variant="ghost" onClick={() => onChange(NO_FILTERS)}>Clear</Button>
        </>
      ) : null}
    </section>
  );
}
