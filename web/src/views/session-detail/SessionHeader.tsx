import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { Menu } from '../../components/Menu';
import { Button, IconButton, formatDate, formatTime, plural } from '../../components/ui';
import type { SessionSummary } from '../../lib/types';

/**
 * The title, one meta line, and the actions. The three a reader reaches for
 * are buttons with their key in the tooltip; the rest sit behind More.
 */
export function SessionHeader({ session, machineName, busyAction, pinned, collectionsAvailable, showThinking, onShowThinking, onBack, onShare, onExport, onConvert, onPack, onCollection, onPin, onCopyId, onDelete }: {
  session: SessionSummary;
  machineName: string | null;
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
  return (
    <header className="session-header">
      <div className="session-title-row">
        <IconButton className="session-back" label="Back to sessions" title="Back to sessions (Esc)" onClick={onBack}><ArrowLeft size={15} /></IconButton>
        <h1>{session.title}</h1>
        <div className="session-actions" role="group" aria-label="Session actions">
          <Button size="sm" title="Convert (c)" onClick={onConvert}>Convert</Button>
          <Button size="sm" title="Export (e)" disabled={busyAction === 'export'} onClick={onExport}>
            {busyAction === 'export' ? 'Exporting' : 'Export'}
          </Button>
          <Button size="sm" title="Share (s)" onClick={onShare}>Share</Button>
          <Menu
            label="More actions"
            trigger={<MoreHorizontal size={14} aria-hidden="true" />}
            items={[
              { label: 'Pack preview', onSelect: onPack },
              { label: collectionsAvailable ? 'Add to collection' : 'Add to collection (none yet)', onSelect: onCollection, disabled: !collectionsAvailable },
              { label: pinned ? 'Unpin session' : 'Pin session', onSelect: onPin, disabled: busyAction === 'pin' },
              { label: 'Copy session id', onSelect: onCopyId },
              { label: 'Delete session', onSelect: onDelete, danger: true },
            ]}
          />
        </div>
      </div>
      <div className="session-meta-row">
        <p className="session-meta">
          <span>{session.sourceLabel}</span>
          <span className="mono">{session.workspace}</span>
          {session.branch ? <span className="mono">{session.branch}</span> : null}
          {machineName ? <span>{machineName}</span> : null}
          <span>{formatDate(session.createdAt)} {formatTime(session.createdAt)}</span>
          <span>{plural(session.turnCount, 'turn')}</span>
          {pinned ? <span>Pinned</span> : null}
        </p>
        <label className="thinking-control" title="Show thinking (t)">
          <input type="checkbox" checked={showThinking} onChange={(event) => onShowThinking(event.target.checked)} />
          Show thinking
        </label>
      </div>
    </header>
  );
}
