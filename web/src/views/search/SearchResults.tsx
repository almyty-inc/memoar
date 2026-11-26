import { useRef, useState } from 'react';
import { AgentMark } from '../../components/AgentMark';
import { HighlightText, cn, formatRelative, plural } from '../../components/ui';
import { isPlainClick } from '../../components/Shell';
import type { SessionSummary } from '../../lib/types';
import { useListKeys } from '../timeline/use-list-keys';

/**
 * Results as two-line rows: the title, then the passage that matched, with
 * every query term marked. j and k move, Enter opens.
 */
export function SearchResults({ items, query, onOpen }: {
  items: SessionSummary[];
  query: string;
  onOpen: (session: SessionSummary) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  useListKeys({ count: items.length, containerRef: listRef, selected, onMove: setSelected });

  return (
    <ol className="result-list" ref={listRef}>
      {items.map((session, index) => (
        <li key={session.id} data-index={index}>
          <a
            href={`/sessions/${encodeURIComponent(session.id)}`}
            className={cn('result-row', selected === index && 'row-selected')}
            onFocus={() => setSelected(index)}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              onOpen(session);
            }}
          >
            <AgentMark source={session.source} label={session.sourceLabel} />
            <span className="result-body">
              <span className="result-title"><HighlightText text={session.title} query={query} /></span>
              {session.highlight || session.summary ? (
                <span className="result-snippet"><HighlightText text={session.highlight ?? session.summary} query={query} /></span>
              ) : null}
              <span className="result-meta">
                <span>{session.sourceLabel}</span>
                <span className="mono">{session.workspace}</span>
                <span>{plural(session.turnCount, 'turn')}</span>
                <span>{formatRelative(session.updatedAt)}</span>
              </span>
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}
