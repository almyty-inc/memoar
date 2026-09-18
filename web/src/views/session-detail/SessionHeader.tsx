import { ArrowLeft, Braces, Download, GitBranch, Laptop, Pin, RefreshCw, Share2 } from 'lucide-react';
import type { SessionSummary } from '../../lib/types';
import { Badge, Button, IconButton, RedactionBadge, SourceBadge, formatRelative } from '../../components/ui';

export function SessionHeader({ session, machineName, busyAction, onBack, setShareOpen, exportSession, setConvertOpen, openPack }: {
  session: SessionSummary;
  machineName: string | null;
  busyAction: string | null;
  onBack: () => void;
  setShareOpen: (open: boolean) => void;
  exportSession: () => Promise<void>;
  setConvertOpen: (open: boolean) => void;
  openPack: () => Promise<void>;
}) {
  return (
    <header className="session-header">
      <div className="session-title-row">
        <IconButton label="Back to timeline" onClick={onBack}><ArrowLeft size={18} /></IconButton>
        <div className="session-heading-copy">
          <div className="session-labels">
            <SourceBadge source={session.source} label={session.sourceLabel} />
            <RedactionBadge status={session.redactionStatus} />
            {session.pinned ? <Badge><Pin size={12} /> Pinned</Badge> : null}
          </div>
          <h1>{session.title}</h1>
          <div className="session-provenance-line">
            <span><GitBranch size={13} /> {session.workspace}</span>
            {/* Shown when known. These read "unknown" and "Archived machine"
                on every session, which is a placeholder wearing the clothes
                of a fact. */}
            {session.branch ? <span>{session.branch}</span> : null}
            {machineName ? <span><Laptop size={13} /> {machineName}</span> : null}
            <span>Updated {formatRelative(session.updatedAt)}</span>
          </div>
        </div>
      </div>
      <div className="session-action-bar" aria-label="Session actions">
        <Button size="sm" onClick={() => setShareOpen(true)}><Share2 size={14} /> Share</Button>
        <Button size="sm" disabled={busyAction === 'export'} onClick={() => void exportSession()}>
          <Download size={14} /> {busyAction === 'export' ? 'Exporting…' : 'Export'}
        </Button>
        <Button size="sm" onClick={() => setConvertOpen(true)}><RefreshCw size={14} /> Convert</Button>
        <Button size="sm" onClick={() => void openPack()}><Braces size={14} /> Pack preview</Button>
      </div>
    </header>
  );
}
