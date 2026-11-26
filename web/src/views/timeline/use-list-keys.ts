import { useEffect, useRef, type RefObject } from 'react';
import { isTyping } from '../../components/Shell';

/**
 * j and k, or the arrow keys, move the selection through a list.
 *
 * The selection belongs to the caller: in the session list it is the session
 * the address names, so moving it updates the transcript beside the list. The
 * row that becomes selected also takes focus, so Enter and the context of a
 * screen reader follow it. Rows are found by `data-index` inside the
 * container, which keeps this working for a virtualised list as long as
 * `scrollTo` brings the row into the DOM first. The arrow keys only steer the
 * list while focus is in it or nowhere in particular, so they keep scrolling
 * the page and moving the caret everywhere else.
 */
export function useListKeys({ count, isSelectable = () => true, containerRef, scrollTo, selected, onMove }: {
  count: number;
  isSelectable?: (index: number) => boolean;
  containerRef: RefObject<HTMLElement | null>;
  scrollTo?: (index: number) => void;
  selected: number | null;
  onMove: (index: number) => void;
}): void {
  const latest = useRef({ count, isSelectable, scrollTo, selected, onMove });
  useEffect(() => { latest.current = { count, isSelectable, scrollTo, selected, onMove }; });

  useEffect(() => {
    const step = (from: number | null, direction: 1 | -1): number | null => {
      const { count: total, isSelectable: selectable } = latest.current;
      let index = from ?? (direction === 1 ? -1 : total);
      for (;;) {
        index += direction;
        if (index < 0 || index >= total) return from;
        if (selectable(index)) return index;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      const container = containerRef.current;
      if (!container) return;
      const active = document.activeElement;
      const inList = active === document.body || active === null || container.contains(active) || active.id === 'main-content';
      const down = event.key === 'j' || (event.key === 'ArrowDown' && inList);
      const up = event.key === 'k' || (event.key === 'ArrowUp' && inList);
      if (!down && !up) return;
      event.preventDefault();
      const next = step(latest.current.selected, down ? 1 : -1);
      if (next === null || next === latest.current.selected) return;
      latest.current.onMove(next);
      latest.current.scrollTo?.(next);
      const focusRow = (attempt: number) => {
        const row = container.querySelector<HTMLElement>(`[data-index="${next}"] a, [data-index="${next}"] button, a[data-index="${next}"], button[data-index="${next}"]`);
        if (row) {
          row.focus({ preventScroll: true });
          if (!latest.current.scrollTo) row.scrollIntoView?.({ block: 'nearest' });
        } else if (attempt < 4) {
          window.requestAnimationFrame(() => focusRow(attempt + 1));
        }
      };
      window.requestAnimationFrame(() => focusRow(0));
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [containerRef]);
}
