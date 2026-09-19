import { AlertCircle, FileQuestion } from 'lucide-react';
import type { Machine, UnparsedSource } from '../../lib/types';
import { Badge } from '../../components/ui';
import { sourceLabel } from '../../lib/source-labels';

/**
 * Files the capture agent uploaded that the archive could not turn into a
 * session, per tool.
 *
 * `memoar doctor` has reported this for a while; nothing on the web did. It
 * matters because a capture pattern aimed at the wrong directory produces a
 * machine that syncs on schedule, reports no error, and archives nothing — it
 * happened twice, and both times it ran for weeks. A tool listed here whose
 * sources have archived no sessions is that failure, so it is named as one.
 *
 * Renders nothing when there is nothing unreadable. Callers hold the list as
 * null until the archive answers and pass an empty list rather than a guess.
 */
export function UnparsedPanel({ items, machines }: { items: UnparsedSource[]; machines: Machine[] }) {
  if (items.length === 0) return null;
  const archiving = new Set(
    machines.flatMap((machine) => machine.sources).filter((source) => source.sessionCount > 0).map((source) => source.id),
  );

  return (
    <section className="data-panel unparsed-panel" aria-labelledby="unparsed-heading">
      <header>
        <div>
          <h2 id="unparsed-heading">Files the archive could not read</h2>
          <p>Collected and kept, so a parser written later can still read them — but never turned into a session.</p>
        </div>
      </header>
      <div className="data-list">
        {items.map((item) => (
          <article className="unparsed-row" key={item.source}>
            <span className="row-icon"><FileQuestion size={16} /></span>
            <div className="unparsed-main">
              <strong>{sourceLabel(item.source)}</strong>
              {item.diagnostic ? <p>{item.diagnostic}</p> : null}
            </div>
            <span className="unparsed-count"><strong>{item.artifacts}</strong> {item.artifacts === 1 ? 'file' : 'files'}</span>
            {archiving.has(item.source) ? null : (
              <Badge className="redaction-findings"><AlertCircle size={12} /> No sessions from this source</Badge>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
