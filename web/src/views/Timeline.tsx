import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  Clock3,
  Filter,
  GitBranch,
  MessageSquare,
  Pin,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Machine, SessionSummary, TimelineGroup } from '../lib/types';
import {
  Button,
  RedactionBadge,
  SourceBadge,
  cn,
  formatNumber,
  formatRelative,
} from '../components/ui';

type TimelineItem =
  | { type: 'date'; key: string; date: string; count: number }
  | { type: 'session'; key: string; session: SessionSummary };

/**
 * "Today" was the literal date 2026-08-17, so one day in August was labelled
 * today forever and the actual today was labelled by its weekday. The reference
 * point is the moment the archive was loaded, passed in rather than read during
 * render.
 */
function friendlyDate(date: string, asOf: number): string {
  const day = 24 * 60 * 60 * 1000;
  const startOfDay = (value: number) => Math.floor(value / day);
  const difference = startOfDay(asOf) - startOfDay(new Date(`${date}T12:00:00Z`).valueOf());
  if (difference === 0) return 'Today';
  if (difference === 1) return 'Yesterday';
  return new Intl.DateTimeFormat('en', { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
}

export function SessionCard({ session, onOpen }: { session: SessionSummary; onOpen: (session: SessionSummary) => void }) {
  return (
    <article className="session-card" onDoubleClick={() => onOpen(session)}>
      <button className="session-card-main" type="button" onClick={() => onOpen(session)}>
        <div className="session-card-topline">
          <SourceBadge source={session.source} label={session.sourceLabel} />
          <span className="subtle-text">{formatRelative(session.updatedAt)}</span>
          {session.pinned ? <Pin size={13} className="pin-icon" aria-label="Pinned" /> : null}
        </div>
        <h3>{session.title}</h3>
        <p>{session.summary}</p>
        {/* Only what the session actually has: no placeholder standing in for a
            measurement nobody took. */}
        <div className="session-meta">
          <span><GitBranch size={13} /> {session.workspace}</span>
          {session.branch ? <span className="branch-name">{session.branch}</span> : null}
          <span><MessageSquare size={13} /> {session.turnCount}</span>
          {session.durationMinutes ? <span><Clock3 size={13} /> {session.durationMinutes}m</span> : null}
          {session.tokenCount ? <span>{formatNumber(session.tokenCount)} tokens</span> : null}
        </div>
      </button>
      <div className="session-card-side">
        <RedactionBadge status={session.redactionStatus} />
        <Button size="sm" variant="ghost" onClick={() => onOpen(session)}>Open <ArrowRight size={14} /></Button>
      </div>
    </article>
  );
}

const RANGES: Array<[string, string]> = [
  ['all', 'Any time'],
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
];

/** Whether a session is newer than the cutoff. A null cutoff accepts everything. */
function withinRange(updatedAt: string, cutoff: number | null): boolean {
  if (cutoff === null) return true;
  const at = new Date(updatedAt).valueOf();
  return Number.isFinite(at) && at >= cutoff;
}

export function TimelineView({ groups, machines, archived, asOf, onOpen, onSearch, hasMore, loadingMore, onLoadMore }: {
  groups: TimelineGroup[];
  machines: Machine[];
  /** Sessions in the archive, counted by the server rather than by this page. */
  archived: number;
  /** When the archive was loaded, so "today" is not read during render. */
  asOf: number;
  onOpen: (session: SessionSummary) => void;
  onSearch: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
}) {
  const activeSources = new Set(
    machines.flatMap((machine) => machine.sources.filter((source) => source.sessionCount > 0).map((source) => source.id)),
  ).size;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState('all');
  const [workspace, setWorkspace] = useState('all');
  // The cutoff is stamped when the range is chosen — an event, where reading
  // the clock is fine — rather than during render, which must stay pure.
  const [within, setWithin] = useState('all');
  const [cutoff, setCutoff] = useState<number | null>(null);

  const chooseRange = (value: string) => {
    setWithin(value);
    const days = Number(value);
    setCutoff(value === 'all' || !Number.isFinite(days) ? null : Date.now() - days * 24 * 60 * 60 * 1000);
  };
  const [filtersOpen, setFiltersOpen] = useState(false);

  const sessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups]);
  const sources = [...new Map(sessions.map((session) => [session.source, session.sourceLabel])).entries()];
  const workspaces = [...new Set(sessions.map((session) => session.workspace))];
  const filteredGroups = useMemo(() => groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((session) =>
        (source === 'all' || session.source === source)
        && (workspace === 'all' || session.workspace === workspace)
        && withinRange(session.updatedAt, cutoff)),
    }))
    .filter((group) => group.sessions.length > 0), [groups, source, workspace, cutoff]);

  const items = useMemo<TimelineItem[]>(() => filteredGroups.flatMap((group) => [
    { type: 'date' as const, key: `date-${group.date}`, date: group.date, count: group.sessions.length },
    ...group.sessions.map((session) => ({ type: 'session' as const, key: session.id, session })),
  ]), [filteredGroups]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => items[index]?.type === 'date' ? 58 : 178,
    overscan: 5,
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      const nearEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 240;
      if (nearEnd && hasMore && !loadingMore) void onLoadMore();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [hasMore, loadingMore, onLoadMore]);

  const filtersApplied = Number(source !== 'all') + Number(workspace !== 'all') + Number(within !== 'all');

  return (
    <div className="page timeline-page">
      <section className="page-heading timeline-heading">
        <div>
          <div className="eyebrow"><Sparkles size={13} /> Your complete coding history</div>
          <h1>Pick up where you left off.</h1>
          <p>Sessions from every connected agent and machine, preserved in one branch-aware archive.</p>
        </div>
        {/*
          These read 635 sessions, 1.8m tokens and 5 sources whatever the
          archive held — three numbers nobody counted, sitting where a summary
          belongs. Sessions are now the server's own count of what matches;
          sources and machines are counted from what each machine reports. There
          is no token figure: the client holds one page of sessions, and a total
          it cannot see is not a total it may claim.
        */}
        <div className="archive-stats" aria-label="Archive summary">
          <div><strong>{formatNumber(archived)}</strong><span>{archived === 1 ? 'session' : 'sessions'}</span></div>
          <div><strong>{activeSources}</strong><span>{activeSources === 1 ? 'source' : 'sources'}</span></div>
          <div><strong>{machines.length}</strong><span>{machines.length === 1 ? 'machine' : 'machines'}</span></div>
        </div>
      </section>

      <section className="toolbar" aria-label="Timeline filters">
        <div className="toolbar-left">
          <Button className="mobile-filter-button" size="sm" onClick={() => setFiltersOpen(!filtersOpen)}>
            <SlidersHorizontal size={15} /> Filters {filtersApplied ? <span className="filter-count">{filtersApplied}</span> : null}
          </Button>
          <div className={cn('filter-controls', filtersOpen && 'filter-controls-open')}>
            <label className="select-control">
              <span className="sr-only">Filter by source</span>
              <Filter size={14} />
              <select value={source} onChange={(event) => setSource(event.target.value)}>
                <option value="all">All sources</option>
                {sources.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <ChevronDown size={13} />
            </label>
            <label className="select-control">
              <span className="sr-only">Filter by workspace</span>
              <GitBranch size={14} />
              <select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
                <option value="all">All workspaces</option>
                {workspaces.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <ChevronDown size={13} />
            </label>
            <label className="select-control">
              <CalendarDays size={14} />
              <select value={within} onChange={(event) => chooseRange(event.target.value)}>
                {RANGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <ChevronDown size={13} />
            </label>
            {filtersApplied ? (
              <Button size="sm" variant="ghost" onClick={() => { setSource('all'); setWorkspace('all'); chooseRange('all'); }}>
                <X size={14} /> Clear
              </Button>
            ) : null}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onSearch}>Search archive <span className="shortcut-hint">⌘K</span></Button>
      </section>

      <div className="timeline-scroll" ref={scrollRef} role="feed" aria-label="Archived sessions">
        {items.length ? (
          <div className="virtual-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = items[virtualItem.index];
              if (!item) return null;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className={cn('virtual-row', item.type === 'date' && 'date-row')}
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {item.type === 'date' ? (
                    <div className="date-divider">
                      <h2>{friendlyDate(item.date, asOf)}</h2>
                      <span>{item.count} session{item.count === 1 ? '' : 's'}</span>
                      <div />
                    </div>
                  ) : <SessionCard session={item.session} onOpen={onOpen} />}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="no-filter-results">
            <h3>No sessions match these filters</h3>
            <p>Clear a filter to return to the full archive.</p>
            <Button onClick={() => { setSource('all'); setWorkspace('all'); }}>Clear filters</Button>
          </div>
        )}
        <div className="infinite-marker" aria-label={hasMore ? 'More archive history is available' : 'Archive history is fully loaded'}>
          <span />
          {hasMore ? <Button size="sm" variant="ghost" disabled={loadingMore} onClick={() => void onLoadMore()}>{loadingMore ? 'Loading older sessions…' : 'Load older sessions'}</Button> : <p>All available sessions loaded</p>}
          <span />
        </div>
      </div>
    </div>
  );
}
