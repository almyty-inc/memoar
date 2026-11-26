import type { ReactNode } from 'react';
import { cn } from '../components/ui';
import { shortcutLabel } from '../lib/platform';

/**
 * The core loop: the list on the left and the selected transcript on the
 * right, both live. On a narrow window only one of them fits, so the list
 * shows until a session is chosen and the transcript shows after.
 */
export function SessionsSplit({ list, detail, selected }: {
  list: ReactNode;
  detail: ReactNode;
  selected: boolean;
}) {
  return (
    <div className={cn('split', selected ? 'split-has-selection' : 'split-empty')}>
      <section className="split-list" aria-label="Session list">{list}</section>
      <section className="split-detail" aria-label="Transcript">
        {selected ? detail : (
          <div className="split-placeholder">
            <p>Select a session to read it here.</p>
            <p className="key-hints"><kbd>j</kbd> <kbd>k</kbd> move <span aria-hidden="true">·</span> <kbd>{shortcutLabel('K')}</kbd> commands <span aria-hidden="true">·</span> <kbd>/</kbd> search</p>
          </div>
        )}
      </section>
    </div>
  );
}

/** Whether the list and the transcript fit side by side. Matches session.css. */
export function wideLayout(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1100px)').matches;
}

/** What the transcript pane shows while a session it has not seen loads. */
export function TranscriptSkeleton() {
  return (
    <div className="session-pane" aria-busy="true" role="status" aria-label="Loading session">
      <div className="session-header">
        <span className="skeleton" style={{ width: '46%', height: 14 }} />
        <span className="skeleton" style={{ width: '62%', marginTop: 10 }} />
      </div>
      <div className="transcript">
        {[72, 88, 54, 80].map((width, index) => (
          <div className="turn" key={index}>
            <span className="skeleton" style={{ width: 64, height: 9 }} />
            <span className="skeleton" style={{ width: `${width}%`, marginTop: 10 }} />
            <span className="skeleton" style={{ width: `${width - 20}%`, marginTop: 8 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
