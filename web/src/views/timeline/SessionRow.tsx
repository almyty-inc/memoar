import { AgentMark } from '../../components/AgentMark';
import { cn, formatTime, plural } from '../../components/ui';
import { isPlainClick } from '../../components/Shell';
import type { SessionSummary } from '../../lib/types';
import { projectName, workspaceLabel } from '../../lib/workspace';

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
 * One session: the agent's mark, the title, what was asked, then project,
 * turns and time. A real link, so a modified click opens a new tab, and a
 * plain click shows it beside the list.
 */
export function SessionRow({ session, machineName, selected, onOpen, onPrefetch }: {
  session: SessionSummary;
  machineName?: string | undefined;
  selected: boolean;
  onOpen: (session: SessionSummary) => void;
  onPrefetch?: ((sessionId: string) => void) | undefined;
}) {
  const preview = session.summary.trim();
  return (
    <a
      href={`/sessions/${encodeURIComponent(session.id)}`}
      className={cn('session-row', selected && 'row-selected')}
      aria-current={selected ? 'true' : undefined}
      onMouseEnter={() => onPrefetch?.(session.id)}
      onFocus={() => onPrefetch?.(session.id)}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen(session);
      }}
    >
      <AgentMark source={session.source} label={session.sourceLabel} />
      <span className="session-row-body">
        <span className="sr-only">{session.sourceLabel}: </span>
        <span className="session-row-title">{session.title}</span>
        {preview && preview !== session.title ? <span className="session-row-preview">{preview}</span> : null}
        <span className="session-row-meta">
          <span title={workspaceLabel(session.workspace)}>{projectName(session.workspace)}</span>
          <span>{plural(session.turnCount, 'turn')}</span>
          {machineName ? <span>{machineName}</span> : null}
          <span>{formatTime(session.updatedAt)}</span>
        </span>
      </span>
    </a>
  );
}
