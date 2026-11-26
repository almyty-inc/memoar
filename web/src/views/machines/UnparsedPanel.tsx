import type { Machine, UnparsedSource } from '../../lib/types';
import { plural } from '../../components/ui';
import { sourceLabel } from '../../lib/source-labels';

/**
 * Files the capture agent uploaded that the archive could not turn into a
 * session, per tool. A capture pattern aimed at the wrong directory produces a
 * machine that syncs on schedule, reports no error and archives nothing, so a
 * tool here with no sessions at all is named as that failure.
 *
 * Renders nothing when there is nothing unreadable.
 */
export function UnparsedPanel({ items, machines }: { items: UnparsedSource[]; machines: Machine[] }) {
  if (items.length === 0) return null;
  const archiving = new Set(
    machines.flatMap((machine) => machine.sources).filter((source) => source.sessionCount > 0).map((source) => source.id),
  );

  return (
    <section className="section" aria-labelledby="unparsed-heading">
      <div className="section-head">
        <h2 id="unparsed-heading" className="section-title">Files the archive could not read</h2>
        <p>Kept, so a later parser can still read them.</p>
      </div>
      <div className="row-list">
        {items.map((item) => (
          <div className="row" key={item.source}>
            <strong className="row-name">{sourceLabel(item.source)}</strong>
            <span className="row-main meta">{item.diagnostic ?? ''}</span>
            <span className="row-meta">{plural(item.artifacts, 'file')}</span>
            {archiving.has(item.source) ? null : <span className="row-meta text-warning">No sessions from this source</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
