import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TileGrid, type TileDefinition, type TileLayout } from './TileGrid';

const TILES: TileDefinition[] = [{ id: 'alpha', title: 'Alpha', render: () => <p>body</p> }];
const LAYOUT: TileLayout[] = [{ id: 'alpha', x: 2, y: 2, width: 5, height: 3 }];

/** jsdom has no PointerEvent, so give it one that carries the fields we read. */
beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
  }
  // The grid measures its own width to convert pixels into columns.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1000 });
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
});

function pointer(type: string, x: number, y: number): PointerEvent {
  return new window.PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true });
}

/** One column is (1000 - 14*11)/12 = 71.5px wide, so a step is 85.5px. */
const COLUMN_STEP = (1000 - 14 * 11) / 12 + 14;
const ROW_STEP = 92 + 14;

function drag(handle: HTMLElement, dx: number, dy: number) {
  fireEvent(handle, pointer('pointerdown', 100, 100));
  fireEvent(window, pointer('pointermove', 100 + dx, 100 + dy));
  fireEvent(window, pointer('pointerup', 100 + dx, 100 + dy));
}

describe('TileGrid dragging', () => {
  it('moves a tile by the number of columns and rows dragged', () => {
    const onLayoutChange = vi.fn();
    render(<TileGrid tiles={TILES} layout={LAYOUT} onLayoutChange={onLayoutChange} onReset={vi.fn()} />);
    drag(screen.getByLabelText('Move Alpha'), COLUMN_STEP * 2, ROW_STEP);
    expect(onLayoutChange).toHaveBeenCalledWith([{ id: 'alpha', x: 4, y: 3, width: 5, height: 3 }]);
  });

  it('resizes a tile from its corner handle', () => {
    // The corner handle is the only way to resize with a pointer, so a
    // regression here silently removes the feature.
    const onLayoutChange = vi.fn();
    render(<TileGrid tiles={TILES} layout={LAYOUT} onLayoutChange={onLayoutChange} onReset={vi.fn()} />);
    drag(screen.getByLabelText('Resize Alpha'), COLUMN_STEP * 2, ROW_STEP);
    expect(onLayoutChange).toHaveBeenCalledWith([{ id: 'alpha', x: 2, y: 2, width: 7, height: 4 }]);
  });

  it('keeps a resize inside the grid and above the minimum size', () => {
    const onLayoutChange = vi.fn();
    render(<TileGrid tiles={TILES} layout={LAYOUT} onLayoutChange={onLayoutChange} onReset={vi.fn()} />);
    drag(screen.getByLabelText('Resize Alpha'), -COLUMN_STEP * 9, -ROW_STEP * 9);
    const [next] = onLayoutChange.mock.calls[0]![0] as TileLayout[];
    expect(next!.width).toBeGreaterThanOrEqual(3);
    expect(next!.height).toBeGreaterThanOrEqual(2);
  });

  it('moves a focused tile with the arrow keys, and resizes it with shift', () => {
    const onLayoutChange = vi.fn();
    render(<TileGrid tiles={TILES} layout={LAYOUT} onLayoutChange={onLayoutChange} onReset={vi.fn()} />);
    const tile = screen.getByRole('region', { name: /Alpha tile/ });

    fireEvent.keyDown(tile, { key: 'ArrowRight' });
    expect(onLayoutChange).toHaveBeenLastCalledWith([{ id: 'alpha', x: 3, y: 2, width: 5, height: 3 }]);

    fireEvent.keyDown(tile, { key: 'ArrowRight', shiftKey: true });
    expect(onLayoutChange).toHaveBeenLastCalledWith([{ id: 'alpha', x: 2, y: 2, width: 6, height: 3 }]);
  });

  it('ignores a pointer that is not the one which started the drag', () => {
    const onLayoutChange = vi.fn();
    render(<TileGrid tiles={TILES} layout={LAYOUT} onLayoutChange={onLayoutChange} onReset={vi.fn()} />);
    const handle = screen.getByLabelText('Move Alpha');
    fireEvent(handle, pointer('pointerdown', 100, 100));
    const other = new window.PointerEvent('pointermove', { clientX: 900, clientY: 900, pointerId: 2, bubbles: true });
    fireEvent(window, other);
    fireEvent(window, pointer('pointerup', 100, 100));
    // A second finger must not drag the tile the first one is holding.
    expect(onLayoutChange).toHaveBeenCalledWith([{ id: 'alpha', x: 2, y: 2, width: 5, height: 3 }]);
  });
});
