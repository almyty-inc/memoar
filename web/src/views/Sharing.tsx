import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Clock3,
  Link2,
  Share2,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SessionSummary, ShareGrant, Transfer } from '../lib/types';
import { Badge, Button, Modal, cn, formatDate, formatRelative } from '../components/ui';

type StatusFilter = 'all' | ShareGrant['status'];

const STATUS_FILTERS: StatusFilter[] = ['all', 'active', 'revoked', 'expired'];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function SharingView({ grants, transfers, sessions, asOf, onAcceptTransfer, onDeclineTransfer, onRevokeGrant, onRequestTransfer }: {
  grants: ShareGrant[];
  transfers: Transfer[];
  sessions: SessionSummary[];
  /** When the dashboard was loaded, used for expiry maths. */
  asOf: number;
  onAcceptTransfer: (id: string) => Promise<void>;
  onDeclineTransfer: (id: string) => Promise<void>;
  onRevokeGrant: (id: string) => Promise<void>;
  onRequestTransfer: (input: { sessionId: string; recipientEmail: string }) => Promise<void>;
}) {
  const [tab, setTab] = useState<'links' | 'transfers'>('links');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [transferOpen, setTransferOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visibleGrants = useMemo(
    () => (status === 'all' ? grants : grants.filter((grant) => grant.status === status)),
    [grants, status],
  );

  // Every figure here is derived from the grants on screen. This panel used to
  // read "16 shared views this month", "1 link expires this week" and "14
  // sensitive fields masked" as literals, none of which came from anywhere.
  // View counts are not tracked at all, so that statistic is simply not shown.
  // asOf is stamped when the dashboard loads, so "expires this week" is
  // measured against a real moment without reading the clock during render.
  const stats = useMemo(() => ({
    active: grants.filter((grant) => grant.status === 'active').length,
    expiringThisWeek: grants.filter((grant) => {
      if (grant.status !== 'active' || !grant.expiresAt) return false;
      const at = new Date(grant.expiresAt).valueOf();
      return at > asOf && at - asOf <= WEEK_MS;
    }).length,
    pendingTransfers: transfers.filter((transfer) => transfer.status === 'pending').length,
  }), [grants, transfers, asOf]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page sharing-page">
      <section className="page-heading row-heading">
        <div><div className="eyebrow"><Share2 size={13} /> Controlled portability</div><h1>Sharing</h1><p>Review redactions before a session leaves your private archive.</p></div>
      </section>

      {/*
        Links are created from a session, because the redaction review a link
        requires belongs to one. The button that used to sit here opened a
        modal with invented findings for no particular session and a "Create
        link" button that did nothing.
      */}
      <section className="privacy-banner">
        <span><ShieldCheck size={20} /></span>
        <div><strong>Visibility stays private until review is complete.</strong><p>Open a session and choose Share to review its redactions and mint a link.</p></div>
      </section>

      {error ? <section className="privacy-banner" role="alert"><span><X size={20} /></span><div><strong>Sharing action failed</strong><p>{error}</p></div></section> : null}

      <div className="tabs" role="tablist" aria-label="Sharing sections">
        <button role="tab" aria-selected={tab === 'links'} className={cn(tab === 'links' && 'active')} onClick={() => setTab('links')} type="button"><Link2 size={15} /> Share links <Badge>{grants.length}</Badge></button>
        <button role="tab" aria-selected={tab === 'transfers'} className={cn(tab === 'transfers' && 'active')} onClick={() => setTab('transfers')} type="button"><Users size={15} /> Transfers <Badge>{stats.pendingTransfers}</Badge></button>
      </div>

      {tab === 'links' ? (
        <section className="data-panel" role="tabpanel">
          <header>
            <div><h2>Active links</h2><p>Viewer and importer access to redacted session copies.</p></div>
            <label className="field-label inline-filter">Status
              <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
                {STATUS_FILTERS.map((option) => <option key={option} value={option}>{option === 'all' ? 'All statuses' : option}</option>)}
              </select>
            </label>
          </header>
          <div className="data-list">
            {visibleGrants.length === 0 ? <p className="empty-note">No {status === 'all' ? '' : `${status} `}share links.</p> : null}
            {visibleGrants.map((grant) => (
              <article className="share-row" key={grant.id}>
                <span className="row-icon"><Link2 size={16} /></span>
                {/*
                  No token here on purpose: GET /sharing/links does not return
                  one. A share token is a bearer secret, shown once when the
                  link is minted and never listed again, so this row identifies
                  the grant rather than reproducing the secret.
                */}
                <div className="share-main">
                  <strong>{grant.sessionTitle}</strong>
                  <small>Created {formatRelative(grant.createdAt)}</small>
                </div>
                <div className="share-meta"><Badge className="permission-badge">{grant.permission}</Badge></div>
                <div className="share-meta"><span>{grant.expiresAt ? `Expires ${formatDate(grant.expiresAt)}` : 'No expiry'}</span></div>
                <Badge className={cn(grant.status === 'active' && 'status-active')}><span /> {grant.status}</Badge>
                {grant.status === 'active' ? (
                  <Button size="sm" variant="ghost" disabled={busy === grant.id} onClick={() => void run(grant.id, () => onRevokeGrant(grant.id))}>
                    <Trash2 size={14} /> Revoke
                  </Button>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section className="data-panel" role="tabpanel">
          <header>
            <div><h2>Session transfers</h2><p>Incoming copies and outgoing ownership handoffs.</p></div>
            <Button size="sm" disabled={sessions.length === 0} onClick={() => setTransferOpen(true)}>Request transfer</Button>
          </header>
          <div className="data-list">
            {transfers.length === 0 ? <p className="empty-note">No transfers yet.</p> : null}
            {transfers.map((transfer) => (
              <article className="transfer-row" key={transfer.id}>
                <span className={cn('row-icon', transfer.direction === 'incoming' && 'incoming')}>{transfer.direction === 'incoming' ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}</span>
                <div><strong>{transfer.sessionTitle}</strong><p>{transfer.direction === 'incoming' ? `From ${transfer.senderEmail}` : `To ${transfer.recipientEmail}`}</p></div>
                <Badge>{transfer.direction}</Badge>
                <span>{formatRelative(transfer.createdAt)}</span>
                {transfer.status === 'pending' && transfer.direction === 'incoming' ? (
                  <div className="transfer-actions">
                    <Button size="sm" variant="primary" disabled={busy === transfer.id} onClick={() => void run(transfer.id, () => onAcceptTransfer(transfer.id))}><Check size={14} /> Accept</Button>
                    <Button size="sm" variant="ghost" disabled={busy === transfer.id} onClick={() => void run(transfer.id, () => onDeclineTransfer(transfer.id))}><X size={14} /> Decline</Button>
                  </div>
                ) : <Badge className={cn(transfer.status === 'accepted' && 'status-active')}><UserCheck size={12} /> {transfer.status}</Badge>}
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="sharing-stats">
        <div><Link2 size={17} /><span><strong>{stats.active}</strong> active {stats.active === 1 ? 'link' : 'links'}</span></div>
        <div><Clock3 size={17} /><span><strong>{stats.expiringThisWeek}</strong> {stats.expiringThisWeek === 1 ? 'link expires' : 'links expire'} this week</span></div>
        <div><Users size={17} /><span><strong>{stats.pendingTransfers}</strong> pending {stats.pendingTransfers === 1 ? 'transfer' : 'transfers'}</span></div>
      </section>

      <RequestTransferModal
        open={transferOpen}
        sessions={sessions}
        busy={busy === 'transfer'}
        onClose={() => setTransferOpen(false)}
        onSubmit={(input) => void run('transfer', async () => {
          await onRequestTransfer(input);
          setTransferOpen(false);
        })}
      />
    </div>
  );
}

function RequestTransferModal({ open, sessions, busy, onClose, onSubmit }: {
  open: boolean;
  sessions: SessionSummary[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { sessionId: string; recipientEmail: string }) => void;
}) {
  const [sessionId, setSessionId] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const chosen = sessionId || sessions[0]?.id || '';

  return (
    <Modal open={open} title="Request transfer" description="The recipient receives a redacted copy once they accept." onClose={onClose}>
      <div className="modal-body">
        <label className="field-label">Session
          <select value={chosen} onChange={(event) => setSessionId(event.target.value)}>
            {sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
          </select>
        </label>
        <label className="field-label">Recipient email
          <input type="email" value={recipientEmail} placeholder="teammate@example.com" onChange={(event) => setRecipientEmail(event.target.value)} />
        </label>
      </div>
      <footer className="modal-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !chosen || !recipientEmail.includes('@')} onClick={() => onSubmit({ sessionId: chosen, recipientEmail })}>
          {busy ? 'Requesting…' : 'Request transfer'}
        </Button>
      </footer>
    </Modal>
  );
}
