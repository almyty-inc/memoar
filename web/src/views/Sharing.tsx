import { useMemo, useState } from 'react';
import type { SessionSummary, ShareGrant, Transfer } from '../lib/types';
import { Button, Modal, PageHeader, cn, formatDate, formatRelative, plural } from '../components/ui';

type StatusFilter = 'all' | ShareGrant['status'];

const STATUS_FILTERS: StatusFilter[] = ['all', 'active', 'revoked', 'expired'];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function SharingView({ grants, transfers, sessions, asOf, onAcceptTransfer, onDeclineTransfer, onRevokeGrant, onRequestTransfer, onTeams }: {
  grants: ShareGrant[];
  transfers: Transfer[];
  sessions: SessionSummary[];
  /** When the dashboard was loaded, used for expiry maths. */
  asOf: number;
  onAcceptTransfer: (id: string) => Promise<void>;
  onDeclineTransfer: (id: string) => Promise<void>;
  onRevokeGrant: (id: string) => Promise<void>;
  onRequestTransfer: (input: { sessionId: string; recipientEmail: string }) => Promise<void>;
  onTeams?: () => void;
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

  // Every figure is derived from the grants on screen. View counts are not
  // tracked, so none is shown.
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
      <PageHeader title="Shared">
        {onTeams ? <Button size="sm" variant="ghost" onClick={onTeams}>Teams</Button> : null}
        {tab === 'transfers' ? <Button size="sm" disabled={sessions.length === 0} onClick={() => setTransferOpen(true)}>Request transfer</Button> : null}
      </PageHeader>

      <p className="summary-line">
        <span>{stats.active} active {stats.active === 1 ? 'link' : 'links'}</span>
        <span>{stats.expiringThisWeek} {stats.expiringThisWeek === 1 ? 'link expires' : 'links expire'} this week</span>
        <span>{plural(stats.pendingTransfers, 'pending transfer')}</span>
      </p>

      {error ? <div className="notice notice-error" role="alert"><p><strong>Sharing action failed.</strong> {error}</p></div> : null}

      <div className="tabs" role="tablist" aria-label="Sharing sections">
        <button role="tab" aria-selected={tab === 'links'} onClick={() => setTab('links')} type="button">Links <span className="count">{grants.length}</span></button>
        {/* Both counts are what the tab holds. */}
        <button role="tab" aria-selected={tab === 'transfers'} onClick={() => setTab('transfers')} type="button">Transfers <span className="count">{transfers.length}</span></button>
      </div>

      {tab === 'links' ? (
        <section role="tabpanel" aria-label="Share links">
          <div className="list-toolbar tab-toolbar">
            <label>
              <span className="sr-only">Filter by status</span>
              <select className="select-plain" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
                {STATUS_FILTERS.map((option) => <option key={option} value={option}>{option === 'all' ? 'All statuses' : option.charAt(0).toUpperCase() + option.slice(1)}</option>)}
              </select>
            </label>
            <span className="meta">A link is made from a session's Share button, after its redaction review.</span>
          </div>
          <div className="row-list">
            {visibleGrants.length === 0 ? <p className="empty-note">No {status === 'all' ? '' : `${status} `}share links.</p> : null}
            {visibleGrants.map((grant) => (
              // No token here: a share token is shown once, when the link is made.
              <div className="row share-row" key={grant.id}>
                <span className={cn('dot', grant.status === 'active' && 'dot-ok')} aria-hidden="true" />
                <span className="row-main">{grant.sessionTitle}</span>
                <span className="row-meta">{grant.permission === 'viewer' ? 'Can view' : 'Can import'}</span>
                <span className="row-meta">{grant.expiresAt ? `Expires ${formatDate(grant.expiresAt)}` : 'No expiry'}</span>
                <span className="row-meta">Created {formatRelative(grant.createdAt)}</span>
                <span className="row-meta status-cell">{grant.status.charAt(0).toUpperCase() + grant.status.slice(1)}</span>
                <span className="row-actions">
                  {grant.status === 'active' ? (
                    <Button size="sm" variant="ghost" disabled={busy === grant.id} onClick={() => void run(grant.id, () => onRevokeGrant(grant.id))}>Revoke</Button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section role="tabpanel" aria-label="Session transfers">
          <h2 className="sr-only">Session transfers</h2>
          <div className="row-list tab-list">
            {transfers.length === 0 ? <p className="empty-note">No transfers yet.</p> : null}
            {transfers.map((transfer) => (
              <div className="row transfer-row" key={transfer.id}>
                <span className="row-meta direction">{transfer.direction === 'incoming' ? 'From' : 'To'}</span>
                <span className="row-meta transfer-who">{transfer.direction === 'incoming' ? transfer.senderEmail : transfer.recipientEmail}</span>
                <span className="row-main">{transfer.sessionTitle}</span>
                <span className="row-meta">{formatRelative(transfer.createdAt)}</span>
                {transfer.status === 'pending' && transfer.direction === 'incoming' ? (
                  <span className="row-actions">
                    <Button size="sm" variant="primary" disabled={busy === transfer.id} onClick={() => void run(transfer.id, () => onAcceptTransfer(transfer.id))}>Accept</Button>
                    <Button size="sm" variant="ghost" disabled={busy === transfer.id} onClick={() => void run(transfer.id, () => onDeclineTransfer(transfer.id))}>Decline</Button>
                  </span>
                ) : <span className="row-meta status-cell">{transfer.status.charAt(0).toUpperCase() + transfer.status.slice(1)}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

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
    <Modal open={open} title="Request transfer" description="The recipient gets a redacted copy once they accept." onClose={onClose}>
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
          {busy ? 'Requesting' : 'Request transfer'}
        </Button>
      </footer>
    </Modal>
  );
}
