import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { agentTone } from '../../components/AgentMark';
import { Menu } from '../../components/Menu';
import { Button, IconButton, cn, formatDate, formatTime, plural } from '../../components/ui';
import type { SessionSummary } from '../../lib/types';

/**
 * Tags, the title, one line of when and how long, and the actions. The three
 * a reader reaches for are buttons with their key in the tooltip; the rest sit
 * behind More.
 */
export function SessionHeader({ session, machineName, models, busyAction, pinned, collectionsAvailable, showThinking, onShowThinking, onBack, onShare, onExport, onConvert, onPack, onCollection, onPin, onCopyId, onDelete }: {
  session: SessionSummary;
  machineName: string | null;
  models: string[];
  busyAction: string | null;
  pinned: boolean;
  collectionsAvailable: boolean;
  showThinking: boolean;
  onShowThinking: (value: boolean) => void;
  onBack: () => void;
  onShare: () => void;
  onExport: () => void;
  onConvert: () => void;
  onPack: () => void;
  onCollection: () => void;
  onPin: () => void;
  onCopyId: () => void;
  onDelete: () => void;
}) {
  const started = new Date(session.createdAt);
  const ended = new Date(session.updatedAt);
  const sameDay = started.toDateString() === ended.toDateString();
  return (
    <header className="session-header">
      <div className="session-header-main">
        <IconButton className="session-back" label="Back to sessions" title="Back to sessions (Esc)" onClick={onBack}><ArrowLeft size={16} /></IconButton>
        <div className="session-tags">
          <span className={cn('tag', `agent-${agentTone(session.source)}`)}>{session.sourceLabel}</span>
          {models.slice(0, 2).map((model) => <span className="tag mono-tag" key={model}>{model}</span>)}
          <span className="tag" title={session.workspace}>{session.workspace.split('/').filter(Boolean).at(-1) ?? session.workspace}{session.branch ? ` · ${session.branch}` : ''}</span>
          {machineName ? <span className="tag">{machineName}</span> : null}
          {pinned ? <span className="tag">Pinned</span> : null}
        </div>
        <h1>{session.title}</h1>
        <p className="session-meta">
          <span>{formatDate(session.createdAt)} {formatTime(session.createdAt)}{sameDay && session.updatedAt !== session.createdAt ? ` to ${formatTime(session.updatedAt)}` : ''}</span>
          <span>{plural(session.turnCount, 'turn')}</span>
          {session.durationMinutes ? <span>{plural(session.durationMinutes, 'minute')}</span> : null}
        </p>
      </div>
      <div className="session-side">
        <div className="session-actions" role="group" aria-label="Session actions">
          <Button size="sm" title="Share (s)" onClick={onShare}>Share</Button>
          <Button size="sm" title="Export (e)" disabled={busyAction === 'export'} onClick={onExport}>
            {busyAction === 'export' ? 'Exporting' : 'Export'}
          </Button>
          <Button size="sm" variant="primary" title="Convert (c)" onClick={onConvert}>Convert</Button>
          <Menu
            label="More actions"
            trigger={<MoreHorizontal size={15} aria-hidden="true" />}
            items={[
              { label: 'Pack preview', onSelect: onPack },
              { label: collectionsAvailable ? 'Add to collection' : 'Add to collection (none yet)', onSelect: onCollection, disabled: !collectionsAvailable },
              { label: pinned ? 'Unpin session' : 'Pin session', onSelect: onPin, disabled: busyAction === 'pin' },
              { label: 'Copy session id', onSelect: onCopyId },
              { label: 'Delete session', onSelect: onDelete, danger: true },
            ]}
          />
        </div>
        <label className="thinking-control" title="Show thinking (t)">
          <input type="checkbox" checked={showThinking} onChange={(event) => onShowThinking(event.target.checked)} />
          Show thinking
        </label>
      </div>
    </header>
  );
}
