import { useCallback, useRef, useState } from 'react';
import { memoarApi } from '../lib/api';
import type { SessionDetailData } from '../lib/types';

/**
 * Loaded transcripts, kept for the life of the tab.
 *
 * Moving through the list with j and k shows the next transcript at once
 * because it was fetched while the previous one was being read: the list
 * prefetches the neighbours of the selected row and whatever the pointer rests
 * on. A request already in flight is shared rather than repeated.
 */
export function useSessionCache() {
  const cache = useRef(new Map<string, SessionDetailData>());
  const inflight = useRef(new Map<string, Promise<SessionDetailData>>());
  const [version, setVersion] = useState(0);

  const load = useCallback((id: string): Promise<SessionDetailData> => {
    const cached = cache.current.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.current.get(id);
    if (pending) return pending;
    const request = memoarApi.getSession({ id }).then((loaded) => {
      cache.current.set(id, loaded);
      setVersion((count) => count + 1);
      return loaded;
    }).finally(() => { inflight.current.delete(id); });
    inflight.current.set(id, request);
    return request;
  }, []);

  /** Fetch ahead of need. A failure here is retried when the row is opened. */
  const prefetch = useCallback((id: string | undefined) => {
    if (!id || !memoarApi.authenticated || cache.current.has(id)) return;
    load(id).catch(() => undefined);
  }, [load]);

  const peek = useCallback((id: string | undefined) => (id ? cache.current.get(id) : undefined), []);
  const drop = useCallback((id: string) => { cache.current.delete(id); setVersion((count) => count + 1); }, []);

  return { load, prefetch, peek, drop, version };
}
