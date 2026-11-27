import { useEffect, useState } from 'react';
import { memoarApi } from '../../lib/api';
import type { WireSessionFacets } from '../../lib/api/wire';

export type LoadFacets = () => Promise<WireSessionFacets>;

const defaultLoad: LoadFacets = () => memoarApi.sessionFacets();

/**
 * Every agent and project in the archive, once the archive answers.
 *
 * Null until then, or when it cannot answer: the filters fall back to what
 * the loaded sessions and machines show, so a failure costs options, not the
 * page.
 */
export function useSessionFacets(load: LoadFacets = defaultLoad): WireSessionFacets | null {
  const [facets, setFacets] = useState<WireSessionFacets | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (answer) => { if (live) setFacets(answer); },
      () => { if (live) setFacets(null); },
    );
    return () => { live = false; };
  }, [load]);
  return facets;
}
