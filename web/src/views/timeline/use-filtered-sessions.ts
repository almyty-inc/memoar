import { useCallback, useEffect, useMemo, useState } from 'react';
import { mergeTimelinePage } from '../../app/bootstrap';
import { memoarApi } from '../../lib/api';
import type { SessionQuery, TimelinePage } from '../../lib/api/client-sessions';
import type { TimelineGroup } from '../../lib/types';
import { isFiltered, type Filters } from './TimelineFilters';

export type LoadFiltered = (query: SessionQuery, cursor: string | null) => Promise<TimelinePage>;

// One empty list, so a caller memoising on the groups is not recomputed each render.
const NONE: TimelineGroup[] = [];

const defaultLoad: LoadFiltered = (query, cursor) => memoarApi.listSessions(query, cursor);

/** The filters as the archive's session list reads them. */
export function queryFor(filters: Filters): SessionQuery {
  return {
    ...(filters.source !== 'all' ? { agent: filters.source } : {}),
    ...(filters.workspace !== 'all' ? { workspace: filters.workspace } : {}),
    ...(filters.cutoff !== null ? { from: new Date(filters.cutoff).toISOString() } : {}),
  };
}

/*
  The archive matches a project as a case-insensitive substring of its path,
  so `/work/app` also brings back `/work/app-old`. The list keeps only the
  project that was chosen.
*/
function exactProject(groups: TimelineGroup[], workspace: string | undefined): TimelineGroup[] {
  if (!workspace) return groups;
  return groups
    .map((group) => ({ date: group.date, sessions: group.sessions.filter((session) => session.workspace === workspace) }))
    .filter((group) => group.sessions.length > 0);
}

interface Loaded {
  key: string;
  groups: TimelineGroup[];
  total: number;
  nextCursor: string | null;
  error: string | null;
}

export interface FilteredSessions {
  active: boolean;
  loading: boolean;
  groups: TimelineGroup[];
  total: number;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
}

/**
 * The sessions a filter matches, page by page from the archive.
 *
 * Filtering the pages already loaded missed every older session and never
 * offered an agent that had none among them. With no filter on, this holds
 * nothing and the caller shows the timeline as before.
 */
export function useFilteredSessions(filters: Filters, load: LoadFiltered = defaultLoad): FilteredSessions {
  const active = isFiltered(filters);
  const query = useMemo(() => queryFor(filters), [filters]);
  const key = active ? JSON.stringify(query) : '';
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    load(query, null).then(
      (page) => { if (live) setLoaded({ key, groups: exactProject(page.groups, query.workspace), total: page.total, nextCursor: page.nextCursor, error: null }); },
      (error: unknown) => { if (live) setLoaded({ key, groups: [], total: 0, nextCursor: null, error: error instanceof Error ? error.message : 'Sessions could not be loaded' }); },
    );
    return () => { live = false; };
  }, [active, key, query, load]);

  const current = loaded?.key === key ? loaded : null;

  const loadMore = useCallback(async () => {
    if (!current?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await load(query, current.nextCursor);
      setLoaded((previous) => (previous?.key !== key ? previous : {
        ...previous,
        groups: mergeTimelinePage(previous.groups, exactProject(page.groups, query.workspace)),
        nextCursor: page.nextCursor,
      }));
    } catch (error) {
      setLoaded((previous) => (previous?.key !== key ? previous : { ...previous, error: error instanceof Error ? error.message : 'More sessions could not be loaded' }));
    } finally {
      setLoadingMore(false);
    }
  }, [current, loadingMore, load, query, key]);

  return {
    active,
    loading: active && current === null,
    groups: current?.groups ?? NONE,
    total: current?.total ?? 0,
    error: current?.error ?? null,
    hasMore: Boolean(current?.nextCursor),
    loadingMore,
    loadMore,
  };
}
