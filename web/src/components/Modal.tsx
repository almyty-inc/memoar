import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconButton } from './ui';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A dialog. Focus goes in when it opens, stays inside while it is open, and
 * returns to where it came from when it closes. Escape closes it.
 */
export function Modal({ open, title, description, children, onClose }: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cardRef = useRef<HTMLElement>(null);
  // Held in a ref so the effect depends on `open` alone: callers pass a fresh
  // arrow function each render, and re-running the focus work would keep
  // taking the caret back.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const returnTo = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    // An `autoFocus` field inside has already claimed focus. Leave it there.
    if (card && !card.contains(document.activeElement)) card.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { closeRef.current(); return; }
      if (event.key !== 'Tab' || !card) return;
      const stops = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => !node.hasAttribute('disabled'));
      const first = stops[0];
      const last = stops.at(-1);
      if (!first || !last) { event.preventDefault(); card.focus(); return; }
      const active = document.activeElement;
      const leavingForward = !event.shiftKey && (active === last || !card.contains(active));
      const leavingBackward = event.shiftKey && (active === first || active === card || !card.contains(active));
      if (leavingForward) { event.preventDefault(); first.focus(); }
      if (leavingBackward) { event.preventDefault(); last.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      returnTo?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="modal-card"
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <IconButton label="Close dialog" onClick={onClose}><X size={16} /></IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}
