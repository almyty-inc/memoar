import {
  Box,
  Clock3,
  LibraryBig as Collection,
  MessageSquare,
  Network,
  Pin,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import { useMemo } from 'react';
import type { Collection as CollectionRecord, ContentBlock, SessionDetailData, SessionSummary } from '../../lib/types';
import { Badge, Button, cn, formatNumber } from '../../components/ui';

export function SessionInspector({ detail, session, tags, collections, busyAction, pinId, togglePin, setCollectionOpen, setDeleteOpen }: {
  detail: SessionDetailData;
  session: SessionSummary;
  tags: string[];
  collections: CollectionRecord[];
  busyAction: string | null;
  pinId: string | null;
  togglePin: () => Promise<void>;
  setCollectionOpen: (open: boolean) => void;
  setDeleteOpen: (open: boolean) => void;
}) {
  // The largest of the three, so the bars are comparable with each other rather
  // than each being full.
  const tokenScale = Math.max(detail.tokenTotals.input, detail.tokenTotals.output, detail.tokenTotals.cacheRead);

  const toolCalls = useMemo(() => detail.turns.flatMap((turn) => turn.blocks)
    .filter((block): block is Extract<ContentBlock, { kind: 'tool_call' }> => block.kind === 'tool_call').length, [detail.turns]);

  return (
    <aside className="session-inspector" aria-label="Session details">
      <section className="inspector-card overview-card">
        <h2>Session overview</h2>
        <div className="metric-grid">
          <div><MessageSquare size={15} /><strong>{session.turnCount}</strong><span>turns</span></div>
          <div><TerminalSquare size={15} /><strong>{toolCalls}</strong><span>tool calls</span></div>
          <div><Clock3 size={15} /><strong>{session.durationMinutes === undefined ? '—' : `${session.durationMinutes}m`}</strong><span>duration</span></div>
          <div><WandSparkles size={15} /><strong>{formatNumber(session.tokenCount)}</strong><span>tokens</span></div>
        </div>
        {/*
          Bars drawn from the numbers beside them. They were fixed at 62%
          and 39% whatever the session used — two rectangles that looked
          like a measurement — and cache read had no bar at all, so the one
          row you could not compare was the one with no picture.
        */}
        <div className="token-bars">
          {([
            ['Input', detail.tokenTotals.input, ''],
            ['Output', detail.tokenTotals.output, 'output'],
            ['Cache read', detail.tokenTotals.cacheRead, 'cache'],
          ] as const).map(([label, value, modifier]) => (
            <div key={label} className="token-bar-row">
              <div><span>{label}</span><strong>{formatNumber(value)}</strong></div>
              <span className={cn('token-bar', modifier)}>
                <span style={{ width: `${tokenScale === 0 ? 0 : Math.round((value / tokenScale) * 100)}%` }} />
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="inspector-card">
        <h2>Provenance</h2>
        {detail.provenance.length === 0 ? (
          <p className="raw-note">No provenance recorded for this session.</p>
        ) : detail.provenance.map((item, index) => (
          // sourceId and parserVersion are optional in the canonical model,
          // so neither can be used as a key or rendered unguarded.
          <div className="provenance-item" key={`${item.kind}-${item.sourceId ?? index}`}>
            <span><Network size={15} /></span>
            <div>
              <strong>{item.kind} capture</strong>
              {item.sourceId ? <small>{item.sourceId}</small> : null}
              {item.parserVersion ? <small>Parser {item.parserVersion}</small> : null}
            </div>
            <ShieldCheck size={15} className="success-icon" />
          </div>
        ))}
        <p className="raw-note"><Box size={14} /> Raw artifact preserved and content-addressed.</p>
      </section>

      <section className="inspector-card">
        <h2>Organization</h2>
        {tags.length ? <div className="inspector-tags">{tags.map((tag) => <Badge key={tag}>#{tag}</Badge>)}</div> : null}
        <Button size="sm" variant="ghost" disabled={collections.length === 0} onClick={() => setCollectionOpen(true)}>
          <Collection size={14} /> {collections.length === 0 ? 'No collections yet' : 'Add to collection'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busyAction === 'pin'} onClick={() => void togglePin()}>
          <Pin size={14} /> {pinId ? 'Unpin session' : 'Pin session'}
        </Button>
      </section>

      <Button className="delete-session-button" size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
        <Trash2 size={14} /> Delete session
      </Button>
    </aside>
  );
}
