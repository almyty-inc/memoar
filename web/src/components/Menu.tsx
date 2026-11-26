import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from './ui';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/**
 * A button that opens a short list of actions.
 *
 * Arrow keys move between the items, Escape closes the menu and returns focus
 * to the button, and a click anywhere else closes it.
 */
export function Menu({ label, trigger, items, header, up = false, className, triggerClassName = 'button button-sm' }: {
  /** The accessible name of the button. */
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  /** A line of context above the items, such as the signed-in address. */
  header?: ReactNode;
  /** Opens above the button, for a menu at the bottom of the screen. */
  up?: boolean;
  className?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const first = rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    first?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const stops = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const index = stops.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % stops.length : (index - 1 + stops.length) % stops.length;
    stops[next]?.focus();
  };

  return (
    <div className={cn('menu-anchor', className)} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger}
      </button>
      {open ? (
        <div className={cn('menu', up && 'menu-up')} role="menu" id={menuId} aria-label={label}>
          {header ? <div className="menu-meta">{header}</div> : null}
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={cn(item.danger && 'menu-danger')}
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.onSelect(); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
