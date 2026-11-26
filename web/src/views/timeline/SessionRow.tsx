import { cn, formatTime, plural } from '../../components/ui';
import { isPlainClick } from '../../components/Shell';
import type { SessionSummary } from '../../lib/types';

/**
 * "Today", "Yesterday", or the weekday and date, measured from when the
 * archive was loaded rather than from a clock read during render.
 */
export function friendlyDate(date: string, asOf: number): string {
  const day = 24 * 60 * 60 * 1000;
  const startOfDay = (value: number) => Math.floor(value / day);
  const difference = startOfDay(asOf) - startOfDay(new Date(`${date}T12:00:00Z`).valueOf());
  if (difference === 0) return 'Today';
  if (difference === 1) return 'Yesterday';
  return new Intl.DateTimeFormat('en', { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
}

/**
 * One session as one 32px row. A real link, so it opens in a new tab on a
 * modified click, and a plain click shows it beside the list.
 */
export function SessionRow({ session, machineName, selected, onOpen, onPrefetch }: {
  session: SessionSummary;
  machineName?: string | undefined;
  selected: boolean;
  onOpen: (session: SessionSummary) => void;
  onPrefetch?: ((sessionId: string) => void) | undefined;
}) {
  return (
    <a
      href={`/sessions/${encodeURIComponent(session.id)}`}
      className={cn('session-row session-cols', selected && 'row-selected')}
      aria-current={selected ? 'true' : undefined}
      onMouseEnter={() => onPrefetch?.(session.id)}
      onFocus={() => onPrefetch?.(session.id)}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen(session);
      }}
    >
      <span className="col-source">{session.sourceLabel}</span>
      <span className="col-title" title={session.title}>{session.title}</span>
      <span className="col-project" title={session.workspace}>{session.workspace}</span>
      <span className="col-machine">{machineName ?? ''}</span>
      <span className="col-time">{formatTime(session.updatedAt)}</span>
      <span className="col-turns">{plural(session.turnCount, 'turn')}</span>
    </a>
  );
}
