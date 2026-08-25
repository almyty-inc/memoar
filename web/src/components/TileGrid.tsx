import { GripVertical } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from './ui';

export interface TileLayout {
  id: string;
  /** Column start, 1-based, on a 12-column grid. */
  x: number;
  /** Row start, 1-based. */
  y: number;
  width: number;
  height: number;
}

export interface TileDefinition {
  id: string;
  title: string;
  render: () => ReactNode;
}

export const GRID_COLUMNS = 12;
const ROW_HEIGHT = 92;
const GAP = 14;
const MIN_WIDTH = 3;
const MIN_HEIGHT = 2;

/** Keeps a tile inside the grid and above the minimum usable size. */
export function clampTile(tile: TileLayout): TileLayout {
  const width = Math.max(MIN_WIDTH, Math.min(GRID_COLUMNS, Math.round(tile.width)));
  const height = Math.max(MIN_HEIGHT, Math.round(tile.height));
  return {
    ...tile,
    width,
    height,
    x: Math.max(1, Math.min(GRID_COLUMNS - width + 1, Math.round(tile.x))),
    y: Math.max(1, Math.round(tile.y)),
  };
}

interface DragState {
  id: string;
  mode: 'move' | 'resize';
  pointerId: number;
  startX: number;
  startY: number;
  origin: TileLayout;
  columnWidth: number;
}

/**
 * A dashboard whose tiles can be moved and resized by dragging, with the layout
 * persisted by the caller. Written against pointer events and CSS grid rather
 * than a layout library: the behaviour needed here is small, and a dependency
 * would have to be kept in step with the standalone web lockfile.
 */
export function TileGrid({ tiles, layout, onLayoutChange, onReset }: {
  tiles: readonly TileDefinition[];
  layout: readonly TileLayout[];
  onLayoutChange: (next: TileLayout[]) => void;
  onReset: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<TileLayout | null>(null);

  const positioned = layout.map((tile) => (preview && preview.id === tile.id ? preview : tile));
  const rows = Math.max(6, ...positioned.map((tile) => tile.y + tile.height - 1));

  const begin = useCallback((event: React.PointerEvent, tile: TileLayout, mode: 'move' | 'resize') => {
    const surface = surfaceRef.current;
    if (!surface) return;
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    const columnWidth = (surface.clientWidth - GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
    setDrag({ id: tile.id, mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: tile, columnWidth });
    setPreview(tile);
  }, []);

  useEffect(() => {
    if (!drag) return;

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      const deltaColumns = Math.round((event.clientX - drag.startX) / (drag.columnWidth + GAP));
      const deltaRows = Math.round((event.clientY - drag.startY) / (ROW_HEIGHT + GAP));
      setPreview(clampTile(drag.mode === 'move'
        ? { ...drag.origin, x: drag.origin.x + deltaColumns, y: drag.origin.y + deltaRows }
        : { ...drag.origin, width: drag.origin.width + deltaColumns, height: drag.origin.height + deltaRows }));
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      setPreview((settled) => {
        if (settled) onLayoutChange(layout.map((tile) => (tile.id === settled.id ? settled : tile)));
        return null;
      });
      setDrag(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, layout, onLayoutChange]);

  /**
   * Keyboard equivalents, because a layout that can only be changed by dragging
   * cannot be changed at all by someone who does not use a mouse.
   */
  const onTileKeyDown = (event: React.KeyboardEvent, tile: TileLayout) => {
    const step = event.shiftKey ? 'resize' : 'move';
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    const [dx, dy] = delta;
    const next = clampTile(step === 'move'
      ? { ...tile, x: tile.x + dx, y: tile.y + dy }
      : { ...tile, width: tile.width + dx, height: tile.height + dy });
    onLayoutChange(layout.map((entry) => (entry.id === next.id ? next : entry)));
  };

  return (
    <div className="tile-surface-wrap">
      <div className="tile-toolbar">
        <p>Drag a tile by its handle to move it, or its corner to resize. Arrow keys move a focused tile; hold shift to resize.</p>
        <button type="button" className="tile-reset" onClick={onReset}>Reset layout</button>
      </div>
      <div
        className={cn('tile-surface', drag && 'dragging')}
        ref={surfaceRef}
        style={{ gridTemplateRows: `repeat(${rows}, ${ROW_HEIGHT}px)` }}
      >
        {positioned.map((tile) => {
          const definition = tiles.find((entry) => entry.id === tile.id);
          if (!definition) return null;
          return (
            <section
              key={tile.id}
              className={cn('tile', drag?.id === tile.id && 'tile-active')}
              style={{ gridColumn: `${tile.x} / span ${tile.width}`, gridRow: `${tile.y} / span ${tile.height}` }}
              tabIndex={0}
              aria-label={`${definition.title} tile. Arrow keys move, shift and arrow keys resize.`}
              onKeyDown={(event) => onTileKeyDown(event, tile)}
            >
              <header className="tile-head">
                <button
                  type="button"
                  className="tile-grip"
                  aria-label={`Move ${definition.title}`}
                  onPointerDown={(event) => begin(event, tile, 'move')}
                ><GripVertical size={14} /></button>
                <h2>{definition.title}</h2>
                <span className="tile-size">{tile.width}×{tile.height}</span>
              </header>
              <div className="tile-body">{definition.render()}</div>
              <button
                type="button"
                className="tile-resize"
                aria-label={`Resize ${definition.title}`}
                onPointerDown={(event) => begin(event, tile, 'resize')}
              />
            </section>
          );
        })}
      </div>
    </div>
  );
}
