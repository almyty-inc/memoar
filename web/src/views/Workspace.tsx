import { LayoutGrid } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { TileGrid, clampTile, type TileDefinition, type TileLayout } from '../components/TileGrid';
import { Badge, SourceBadge, formatRelative } from '../components/ui';
import type { Collection, Machine, SessionSummary, ShareGrant, Transfer } from '../lib/types';

const STORAGE_KEY = 'memoar.workspace.layout';

export const DEFAULT_LAYOUT: TileLayout[] = [
  { id: 'recent', x: 1, y: 1, width: 7, height: 5 },
  { id: 'machines', x: 8, y: 1, width: 5, height: 3 },
  { id: 'collections', x: 8, y: 4, width: 5, height: 2 },
  { id: 'sharing', x: 1, y: 6, width: 5, height: 3 },
  { id: 'sources', x: 6, y: 6, width: 7, height: 3 },
];

/**
 * Reads a saved arrangement, keeping only tiles that still exist and forcing
 * every one back inside the grid. A layout stored by an older build must not be
 * able to strand a tile off-screen or resurrect one that has been removed.
 */
export function loadLayout(storage: Pick<Storage, 'getItem'>, known: readonly string[]): TileLayout[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_LAYOUT;
    const saved = parsed
      .filter((entry): entry is TileLayout =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as TileLayout).id === 'string'
        && known.includes((entry as TileLayout).id)
        && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite((entry as unknown as Record<string, number>)[key])))
      .map(clampTile);
    // Tiles added since the layout was saved fall back to their default slot.
    const missing = DEFAULT_LAYOUT.filter((tile) => !saved.some((entry) => entry.id === tile.id));
    return saved.length === 0 ? DEFAULT_LAYOUT : [...saved, ...missing];
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function WorkspaceView({ sessions, archived, machines, collections, grants, transfers, onOpen }: {
  sessions: SessionSummary[];
  /** Sessions in the archive, which is more than the pages loaded so far. */
  archived: number;
  machines: Machine[];
  collections: Collection[];
  grants: ShareGrant[];
  transfers: Transfer[];
  onOpen: (session: SessionSummary) => void;
}) {
  const tiles = useMemo<TileDefinition[]>(() => [
    {
      id: 'recent',
      title: 'Recent sessions',
      render: () => (
        <div className="tile-list">
          {sessions.length === 0 ? <p className="empty-note">No sessions captured yet.</p> : null}
          {sessions.slice(0, 40).map((session) => (
            <button key={session.id} type="button" className="tile-row" onClick={() => onOpen(session)}>
              <SourceBadge source={session.source} label={session.sourceLabel} />
              <span className="tile-row-main">
                <strong>{session.title}</strong>
                <small>{session.workspace}</small>
              </span>
              <span className="tile-row-meta">{formatRelative(session.updatedAt)}</span>
            </button>
          ))}
        </div>
      ),
    },
    {
      id: 'machines',
      title: 'Machines',
      render: () => (
        <div className="tile-list">
          {machines.length === 0 ? <p className="empty-note">No machines connected.</p> : null}
          {machines.map((machine) => (
            <div key={machine.id} className="tile-row static">
              <span className="tile-row-main">
                <strong>{machine.name}</strong>
                <small>{machine.platform} · {machine.sources.length} sources</small>
              </span>
              <Badge className={machine.status === 'online' ? 'status-active' : undefined}>{machine.status}</Badge>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: 'collections',
      title: 'Collections',
      render: () => (
        <div className="tile-list">
          {collections.length === 0 ? <p className="empty-note">No collections yet.</p> : null}
          {collections.map((collection) => (
            <div key={collection.id} className="tile-row static">
              <span className="tile-row-main"><strong>{collection.name}</strong></span>
              <span className="tile-row-meta">{collection.sessionCount}</span>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: 'sharing',
      title: 'Sharing',
      render: () => {
        const active = grants.filter((grant) => grant.status === 'active').length;
        const pending = transfers.filter((transfer) => transfer.status === 'pending').length;
        return (
          <div className="tile-stats">
            <div><strong>{active}</strong><span>active {active === 1 ? 'link' : 'links'}</span></div>
            <div><strong>{pending}</strong><span>pending {pending === 1 ? 'transfer' : 'transfers'}</span></div>
            <div><strong>{grants.length}</strong><span>total {grants.length === 1 ? 'grant' : 'grants'}</span></div>
          </div>
        );
      },
    },
    {
      id: 'sources',
      title: 'Sources by agent',
      render: () => {
        const counts = new Map<string, number>();
        for (const session of sessions) counts.set(session.sourceLabel, (counts.get(session.sourceLabel) ?? 0) + 1);
        const ranked = [...counts].sort((left, right) => right[1] - left[1]);
        const highest = ranked[0]?.[1] ?? 1;
        return (
          <div className="tile-bars">
            {ranked.length === 0 ? <p className="empty-note">Nothing captured yet.</p> : null}
            {/*
              The timeline arrives a page at a time, so this counts what has
              been loaded. Saying so is the difference between a breakdown and
              a breakdown that claims to cover an archive it has not seen.
            */}
            {ranked.length > 0 && sessions.length < archived
              ? <p className="tile-scope">over the {sessions.length} of {archived} sessions loaded</p>
              : null}
            {ranked.map(([label, count]) => (
              <div key={label} className="tile-bar">
                <span>{label}</span>
                <span className="tile-bar-track"><span style={{ width: `${Math.max(4, (count / highest) * 100)}%` }} /></span>
                <span className="tile-bar-count">{count}</span>
              </div>
            ))}
          </div>
        );
      },
    },
  ], [sessions, archived, machines, collections, grants, transfers, onOpen]);

  const [layout, setLayout] = useState<TileLayout[]>(() => loadLayout(window.localStorage, tiles.map((tile) => tile.id)));

  const persist = useCallback((next: TileLayout[]) => {
    setLayout(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // A full or blocked storage should cost the arrangement, not the session.
    }
  }, []);

  const reset = useCallback(() => {
    setLayout(DEFAULT_LAYOUT);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch { /* nothing to clean up */ }
  }, []);

  return (
    <div className="page workspace-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><LayoutGrid size={13} /> Workspace</div>
          <h1>Overview</h1>
          <p>Arrange these panels however you work. The layout is remembered on this device.</p>
        </div>
      </section>
      <TileGrid tiles={tiles} layout={layout} onLayoutChange={persist} onReset={reset} />
    </div>
  );
}
