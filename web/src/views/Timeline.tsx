import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, PageHeader, cn, plural } from '../components/ui';
import type { Machine, SessionSummary, TimelineGroup } from '../lib/types';
import { SessionRow, friendlyDate } from './timeline/SessionRow';
import { TimelineFilters, type Filters, NO_FILTERS, isFiltered, matches } from './timeline/TimelineFilters';
import { useListKeys } from './timeline/use-list-keys';

type TimelineItem =
  | { type: 'date'; key: string; date: string; count: number }
  | { type: 'session'; key: string; session: SessionSummary };

const ROW = 32;

export function TimelineView({ groups, machines, archived, asOf, selectedId, onOpen, onSelect, onPrefetch, onConnect, onImport, hasMore, loadingMore, onLoadMore }: {
  groups: TimelineGroup[];
  machines: Machine[];
  /** Sessions in the archive, counted by the server rather than by this page. */
  archived: number;
  /** When the archive was loaded, so "today" is not read during render. */
  asOf: number;
  /** The session the address names, shown beside the list. */
  selectedId?: string | undefined;
  onOpen: (session: SessionSummary) => void;
  /** Moving with j and k: shows the session without adding a history entry. */
  onSelect?: (session: SessionSummary) => void;
  onPrefetch?: (sessionId: string) => void;
  onConnect: () => void;
  onImport?: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const machineNames = useMemo(() => new Map(machines.map((machine) => [machine.id, machine.name])), [machines]);

  const sessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups]);
  const items = useMemo<TimelineItem[]>(() => groups.flatMap((group) => {
    const shown = group.sessions.filter((session) => matches(session, filters));
    if (shown.length === 0) return [];
    return [
      { type: 'date' as const, key: `date-${group.date}`, date: group.date, count: shown.length },
      ...shown.map((session) => ({ type: 'session' as const, key: session.id, session })),
    ];
  }), [groups, filters]);

  const stickyIndexes = useMemo(() => items.flatMap((item, index) => (item.type === 'date' ? [index] : [])), [items]);
  const activeSticky = useRef(0);
  const rangeExtractor = useCallback((range: Range) => {
    activeSticky.current = [...stickyIndexes].reverse().find((index) => range.startIndex >= index) ?? 0;
    return [...new Set([activeSticky.current, ...defaultRangeExtractor(range)])].sort((left, right) => left - right);
  }, [stickyIndexes]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12,
    rangeExtractor,
  });

  const selectedIndex = useMemo(() => {
    const index = items.findIndex((item) => item.type === 'session' && item.session.id === selectedId);
    return index < 0 ? null : index;
  }, [items, selectedId]);

  const sessionAt = useCallback((index: number) => {
    const item = items[index];
    return item?.type === 'session' ? item.session : undefined;
  }, [items]);

  useListKeys({
    count: items.length,
    isSelectable: (index) => sessionAt(index) !== undefined,
    containerRef: scrollRef,
    scrollTo: (index) => virtualizer.scrollToIndex(index, { align: 'auto' }),
    selected: selectedIndex,
    onMove: (index) => {
      const session = sessionAt(index);
      if (session) (onSelect ?? onOpen)(session);
    },
  });

  // The transcripts either side of the selection are fetched before they are
  // asked for, so j and k never wait on the network.
  useEffect(() => {
    if (selectedIndex === null || !onPrefetch) return;
    for (const offset of [1, -1, 2]) {
      const neighbour = sessionAt(selectedIndex + offset) ?? sessionAt(selectedIndex + offset * 2);
      if (neighbour) onPrefetch(neighbour.id);
    }
  }, [selectedIndex, sessionAt, onPrefetch]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const onScroll = () => {
      const nearEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 240;
      if (nearEnd && hasMore && !loadingMore) void onLoadMore();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [hasMore, loadingMore, onLoadMore]);

  const shown = isFiltered(filters) ? items.filter((item) => item.type === 'session').length : null;

  return (
    <div className="timeline-page">
      <div className="list-top">
        <PageHeader title="Sessions" count={plural(archived, 'session')}>
          {onImport ? <Button size="sm" variant="ghost" onClick={onImport}>Import</Button> : null}
        </PageHeader>
        {/* Filters over an empty archive are controls with one option each. */}
        {sessions.length === 0 ? null : (
          <TimelineFilters sessions={sessions} filters={filters} onChange={setFilters} shown={shown} />
        )}
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          title="No sessions yet."
          body={<>Run <code>memoar login</code> on the machine you code on, then <code>memoar sync --watch</code>.</>}
          action={<Button size="sm" onClick={onConnect}>Connect a machine</Button>}
        />
      ) : (
        <>
          <div className="session-head session-cols" aria-hidden="true">
            <span className="col-source">Source</span><span className="col-title">Title</span><span className="col-project">Project</span>
            <span className="col-machine">Machine</span><span className="col-time">Time</span><span className="col-turns">Turns</span>
          </div>
          <div className="session-scroll" ref={scrollRef} role="feed" aria-label="Sessions">
            {items.length === 0 ? (
              <EmptyState
                title="No sessions match these filters."
                action={<Button size="sm" onClick={() => setFilters(NO_FILTERS)}>Clear filters</Button>}
              />
            ) : (
              <div className="virtual-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const item = items[virtualItem.index];
                  if (!item) return null;
                  const sticky = item.type === 'date' && activeSticky.current === virtualItem.index;
                  return (
                    <div
                      key={item.key}
                      data-index={virtualItem.index}
                      className={cn('virtual-row', sticky && 'sticky')}
                      style={sticky ? { top: 0 } : { transform: `translateY(${virtualItem.start}px)` }}
                    >
                      {item.type === 'date' ? (
                        <div className="day-header" role="heading" aria-level={2}>
                          {friendlyDate(item.date, asOf)} <span>{plural(item.count, 'session')}</span>
                        </div>
                      ) : (
                        <SessionRow
                          session={item.session}
                          machineName={item.session.machineId ? machineNames.get(item.session.machineId) : undefined}
                          selected={selectedIndex === virtualItem.index}
                          onOpen={onOpen}
                          onPrefetch={onPrefetch}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="list-end">
              {hasMore
                ? <Button size="sm" variant="ghost" disabled={loadingMore} onClick={() => void onLoadMore()}>{loadingMore ? 'Loading older sessions' : 'Load older sessions'}</Button>
                : <span>End of archive</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
