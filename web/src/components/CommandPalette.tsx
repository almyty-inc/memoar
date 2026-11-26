import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { HighlightText, cn } from './ui';
import { rank, type Command } from './command-search';

export type { Command } from './command-search';

/**
 * Cmd-K, or Ctrl-K: jump to a session, search transcripts, run an action.
 *
 * Results update on every key. Arrow keys move, Enter runs, Escape closes and
 * puts focus back where it was. The list is a listbox the input controls, so
 * a screen reader hears the active option without focus leaving the field.
 */
export function CommandPalette({ open, commands, onClose }: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const results = useMemo(() => rank(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return undefined;
    const returnTo = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      setQuery('');
      setActive(0);
      returnTo?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-option="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const runAt = (index: number) => {
    const command = results[index];
    if (!command) return;
    onClose();
    command.run(query.trim());
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) { event.preventDefault(); setActive((index) => Math.min(results.length - 1, index + 1)); }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    if (event.key === 'Enter') { event.preventDefault(); runAt(active); }
  };

  let lastGroup = '';
  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            placeholder="Jump to a session, run a command, or search transcripts"
            aria-label="Command"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="palette-list" id={listId} role="listbox" ref={listRef} aria-label="Results">
          {results.length === 0 ? <p className="palette-empty">Nothing matches.</p> : null}
          {results.map((command, index) => {
            const heading = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            return (
              <div key={command.id} role="presentation">
                {heading ? <div className="palette-group" role="presentation">{heading}</div> : null}
                <div
                  id={`${listId}-${index}`}
                  data-option={index}
                  role="option"
                  aria-selected={index === active}
                  className={cn('palette-option', index === active && 'active')}
                  onMouseMove={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runAt(index)}
                >
                  <span className="palette-label"><HighlightText text={command.label(query.trim())} query={command.matchLabel ? query : ''} /></span>
                  {command.detail ? <span className="palette-detail">{command.detail}</span> : null}
                  {command.hint ? <kbd className="palette-hint">{command.hint}</kbd> : null}
                </div>
              </div>
            );
          })}
        </div>
        <footer className="palette-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> run</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}
