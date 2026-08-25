import { describe, expect, it } from 'vitest';
import { GRID_COLUMNS, clampTile } from './TileGrid';
import { DEFAULT_LAYOUT, loadLayout } from '../views/Workspace';

function storage(value: string | null): Pick<Storage, 'getItem'> {
  return { getItem: () => value };
}

const KNOWN = DEFAULT_LAYOUT.map((tile) => tile.id);

describe('clampTile', () => {
  it('keeps a tile from being dragged off the right edge', () => {
    // Dropping a 5-wide tile at column 11 would put two columns outside the
    // grid, where CSS would silently shrink it and the layout would drift.
    expect(clampTile({ id: 'a', x: 11, y: 1, width: 5, height: 3 }).x).toBe(GRID_COLUMNS - 5 + 1);
  });

  it('refuses positions and sizes that would make a tile unusable', () => {
    const tiny = clampTile({ id: 'a', x: -4, y: -2, width: 0, height: 0 });
    expect(tiny.x).toBe(1);
    expect(tiny.y).toBe(1);
    expect(tiny.width).toBeGreaterThanOrEqual(3);
    expect(tiny.height).toBeGreaterThanOrEqual(2);
  });

  it('never lets a tile exceed the grid width', () => {
    expect(clampTile({ id: 'a', x: 1, y: 1, width: 99, height: 3 }).width).toBe(GRID_COLUMNS);
  });
});

describe('loadLayout', () => {
  it('falls back to the default arrangement when nothing is stored', () => {
    expect(loadLayout(storage(null), KNOWN)).toEqual(DEFAULT_LAYOUT);
  });

  it('restores a saved arrangement', () => {
    const saved = [{ id: 'recent', x: 2, y: 3, width: 4, height: 4 }];
    const restored = loadLayout(storage(JSON.stringify(saved)), KNOWN);
    expect(restored.find((tile) => tile.id === 'recent')).toEqual(saved[0]);
  });

  it('drops tiles that no longer exist and adds ones that did not before', () => {
    // A layout saved by an older build must not resurrect a removed tile, nor
    // hide a new one just because it was not in storage.
    const saved = [{ id: 'recent', x: 1, y: 1, width: 6, height: 4 }, { id: 'retired-tile', x: 7, y: 1, width: 6, height: 4 }];
    const restored = loadLayout(storage(JSON.stringify(saved)), KNOWN);
    expect(restored.some((tile) => tile.id === 'retired-tile')).toBe(false);
    expect(new Set(restored.map((tile) => tile.id))).toEqual(new Set(KNOWN));
  });

  it('repairs a stored tile that sits outside the grid', () => {
    const saved = [{ id: 'recent', x: 40, y: 1, width: 30, height: 3 }];
    const restored = loadLayout(storage(JSON.stringify(saved)), KNOWN);
    const recent = restored.find((tile) => tile.id === 'recent')!;
    expect(recent.x).toBeGreaterThanOrEqual(1);
    expect(recent.x + recent.width - 1).toBeLessThanOrEqual(GRID_COLUMNS);
  });

  it.each(['not json at all', '{"not":"an array"}', '[{"id":"recent","x":"left"}]'])(
    'ignores unusable stored value %s rather than rendering nothing',
    (value) => {
      expect(loadLayout(storage(value), KNOWN)).toEqual(DEFAULT_LAYOUT);
    },
  );
});
