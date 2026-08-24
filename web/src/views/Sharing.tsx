import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Clock3,
  Eye,
  FileWarning,
  Link2,
  MoreHorizontal,
  ScanSearch,
  Share2,
  ShieldCheck,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { ShareGrant, Transfer } from '../lib/types';
import { Badge, Button, CopyButton, IconButton, Modal, cn, formatDate, formatRelative } from '../components/ui';

export function SharingView({ grants, transfers, onAcceptTransfer }: { grants: ShareGrant[]; transfers: Transfer[]; onAcceptTransfer: (id: string) => Promise<void> }) {
  const [tab, setTab] = useState<'links' | 'transfers'>('links');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [accepted, setAccepted] = useState<string[]>([]);
  const acceptTransfer = async (id: string) => {
    await onAcceptTransfer(id);
    setAccepted((current) => [...current, id]);
  };

  return (
    <div className="page sharing-page">
      <section className="page-heading row-heading">
        <div><div className="eyebrow"><Share2 size={13} /> Controlled portability</div><h1>Sharing</h1><p>Review redactions before a session leaves your private archive.</p></div>
        <Button variant="primary" onClick={() => setReviewOpen(true)}><Link2 size={16} /> Create share link</Button>
      </section>

      <section className="privacy-banner">
        <span><ShieldCheck size={20} /></span>
        <div><strong>Visibility stays private until review is complete.</strong><p>Share links and transfers use an immutable review record so recipients always see the approved mask.</p></div>
        <Button size="sm" variant="ghost" onClick={() => setReviewOpen(true)}>Open redaction review <ArrowRight size={14} /></Button>
      </section>

      <div className="tabs" role="tablist" aria-label="Sharing sections">
        <button role="tab" aria-selected={tab === 'links'} className={cn(tab === 'links' && 'active')} onClick={() => setTab('links')} type="button"><Link2 size={15} /> Share links <Badge>{grants.length}</Badge></button>
        <button role="tab" aria-selected={tab === 'transfers'} className={cn(tab === 'transfers' && 'active')} onClick={() => setTab('transfers')} type="button"><Users size={15} /> Transfers <Badge>{transfers.filter((item) => item.status === 'pending').length}</Badge></button>
      </div>

      {tab === 'links' ? (
        <section className="data-panel" role="tabpanel">
          <header><div><h2>Active links</h2><p>Viewer and importer access to redacted session copies.</p></div><Button size="sm">All statuses</Button></header>
          <div className="data-list">
            {grants.map((grant) => (
              <article className="share-row" key={grant.id}>
                <span className="row-icon"><Link2 size={16} /></span>
                <div className="share-main"><strong>{grant.sessionTitle}</strong><div><code>{grant.token}</code><CopyButton value={`https://memoar.dev/s/${grant.token ?? grant.id}`} label="Copy link" /></div></div>
                <div className="share-meta"><Badge className="permission-badge">{grant.permission}</Badge><span><Eye size={13} /> {grant.views} views</span></div>
                <div className="share-meta"><span>Created {formatRelative(grant.createdAt)}</span><span>{grant.expiresAt ? `Expires ${formatDate(grant.expiresAt)}` : 'No expiry'}</span></div>
                <Badge className="status-active"><span /> {grant.status}</Badge>
                <IconButton label={`More options for ${grant.sessionTitle}`}><MoreHorizontal size={17} /></IconButton>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section className="data-panel" role="tabpanel">
          <header><div><h2>Session transfers</h2><p>Incoming copies and outgoing ownership handoffs.</p></div><Button size="sm">Request transfer</Button></header>
          <div className="data-list">
            {transfers.map((transfer) => {
              const isAccepted = accepted.includes(transfer.id) || transfer.status === 'accepted';
              return (
                <article className="transfer-row" key={transfer.id}>
                  <span className={cn('row-icon', transfer.direction === 'incoming' && 'incoming')}>{transfer.direction === 'incoming' ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}</span>
                  <div><strong>{transfer.sessionTitle}</strong><p>{transfer.direction === 'incoming' ? `From ${transfer.senderEmail}` : `To ${transfer.recipientEmail}`}</p></div>
                  <Badge>{transfer.direction}</Badge>
                  <span>{formatRelative(transfer.createdAt)}</span>
                  {transfer.status === 'pending' && !isAccepted ? <div className="transfer-actions"><Button size="sm" variant="primary" onClick={() => void acceptTransfer(transfer.id)}><Check size={14} /> Accept</Button><Button size="sm" variant="ghost"><X size={14} /> Decline</Button></div> : <Badge className="status-active"><UserCheck size={12} /> {isAccepted ? 'accepted' : transfer.status}</Badge>}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section className="sharing-stats">
        <div><Eye size={17} /><span><strong>16</strong> shared views this month</span></div>
        <div><Clock3 size={17} /><span><strong>1</strong> link expires this week</span></div>
        <div><ScanSearch size={17} /><span><strong>14</strong> sensitive fields masked</span></div>
      </section>

      <Modal open={reviewOpen} title={reviewed ? 'Review approved' : 'Redaction review'} description={reviewed ? 'The redacted copy is ready for link permissions.' : 'Resolve each finding before choosing who can access this session.'} onClose={() => { setReviewOpen(false); setReviewed(false); }}>
        {!reviewed ? (
          <>
            <div className="modal-body">
              <div className="review-summary"><FileWarning size={20} /><div><strong>2 potential identifiers</strong><p>Design redaction review gate · 28 turns</p></div><Badge className="redaction-findings">Required</Badge></div>
              <div className="redaction-diff">
                <div className="redaction-diff-head"><span>Original</span><span>Recipient sees</span></div>
                <div><code>workspace: /Users/frane/memoar</code><code>workspace: /Users/<mark>[redacted]</mark>/memoar</code></div>
                <div><code>author: dev@example.test</code><code>author: <mark>[email redacted]</mark></code></div>
              </div>
              <label className="review-confirm"><input type="checkbox" defaultChecked /><span><strong>Mask both findings</strong><small>The original remains unchanged in your archive.</small></span></label>
            </div>
            <footer className="modal-actions"><Button variant="ghost" onClick={() => setReviewOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => setReviewed(true)}><ShieldCheck size={15} /> Approve review</Button></footer>
          </>
        ) : (
          <>
            <div className="modal-body approved-review"><span><ShieldCheck size={24} /></span><h3>Safe to share</h3><p>2 masks will be applied. Tool inputs and raw artifacts remain excluded.</p><label className="field-label">Permission<select><option>Viewer · read only</option><option>Importer · can copy</option></select></label><label className="field-label">Expires<select><option>7 days</option><option>30 days</option><option>Never</option></select></label></div>
            <footer className="modal-actions"><Button variant="ghost" onClick={() => setReviewed(false)}>Back</Button><Button variant="primary"><Link2 size={15} /> Create link</Button></footer>
          </>
        )}
      </Modal>
    </div>
  );
}
