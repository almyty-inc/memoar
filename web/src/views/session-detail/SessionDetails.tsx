import { useMemo } from 'react';
import { formatDate, formatNumber, formatTime, plural, redactionSentence } from '../../components/ui';
import type { SessionDetailData } from '../../lib/types';

/**
 * Provenance, token use and the scan result, as a definition list behind a
 * disclosure. Closed by default: the transcript is what the page is for.
 */
export function SessionDetails({ detail, tags }: { detail: SessionDetailData; tags: string[] }) {
  const { session, tokenTotals, provenance } = detail;
  const toolCalls = useMemo(() => detail.turns.flatMap((turn) => turn.blocks).filter((block) => block.kind === 'tool_call').length, [detail.turns]);
  const models = [...new Set(detail.turns.flatMap((turn) => (turn.model ? [turn.model] : [])))];

  return (
    <details className="session-details">
      <summary>Details</summary>
      <dl>
        <dt>Started</dt><dd>{formatDate(session.createdAt)} {formatTime(session.createdAt)}</dd>
        {session.durationMinutes ? <><dt>Duration</dt><dd>{plural(session.durationMinutes, 'minute')}</dd></> : null}
        <dt>Turns</dt><dd>{plural(session.turnCount, 'turn')}, {plural(toolCalls, 'tool call')}</dd>
        {models.length ? <><dt>{models.length === 1 ? 'Model' : 'Models'}</dt><dd className="mono">{models.join(', ')}</dd></> : null}
        <dt>Tokens</dt>
        <dd className="num">{formatNumber(tokenTotals.input)} in, {formatNumber(tokenTotals.output)} out, {formatNumber(tokenTotals.cacheRead)} cache read</dd>
        <dt>Secret scan</dt><dd>{redactionSentence(session.redactionStatus)}</dd>
        {tags.length ? <><dt>Tags</dt><dd>{tags.map((tag) => `#${tag}`).join(' ')}</dd></> : null}
        <dt>Session id</dt><dd className="mono">{session.id}</dd>
        {provenance.length === 0 ? <><dt>Provenance</dt><dd>None recorded</dd></> : provenance.map((item, index) => (
          // sourceId and parserVersion are optional in the canonical model.
          <div className="provenance-item" key={`${item.kind}-${item.sourceId ?? index}`}>
            <dt>{item.kind === 'native' ? 'Captured' : item.kind.charAt(0).toUpperCase() + item.kind.slice(1)}</dt>
            <dd>
              {formatDate(item.capturedAt)}
              {item.parserVersion ? <> with <span className="mono">{item.parserVersion}</span></> : null}
              {item.sourceId ? <><br /><span className="mono meta">raw {item.sourceId}</span></> : null}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
