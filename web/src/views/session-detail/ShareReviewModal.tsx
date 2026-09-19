import { Link2, ScanSearch, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { memoarApi } from '../../lib/api';
import type { Annotation, ShareGrant } from '../../lib/types';
import { Badge, Button, CopyButton, Modal } from '../../components/ui';

/** Turns the chosen expiry option into the timestamp the contract expects. */
function expiresAt(option: string): string | null {
  if (option === 'never') return null;
  const days = Number(option);
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** A finding the secret scanner recorded against this session. */
interface RedactionFinding {
  id: string;
  kind: string;
  preview: string;
}

function readFindings(annotations: Annotation[]): RedactionFinding[] {
  return annotations
    .filter((annotation) => annotation.kind === 'redaction_mask')
    .map((annotation) => ({
      id: annotation.id,
      kind: typeof annotation.value.kind === 'string' ? annotation.value.kind : 'secret',
      preview: typeof annotation.value.preview === 'string' ? annotation.value.preview : '',
    }));
}

/** "aws_access_key" is what the scanner calls it; this is what a person calls it. */
function findingLabel(kind: string): string {
  return kind.replaceAll('_', ' ').replace(/^./u, (first) => first.toUpperCase());
}

export function ShareReviewModal({ open, approved, link, busy, error, sessionId, onApprove, onCreate, onClose }: {
  open: boolean;
  approved: boolean;
  link: string | null;
  busy: boolean;
  /**
   * Why the last attempt did not work. Approving and minting both wrote their
   * failure to a page-level banner this dialog covers, so pressing "Approve
   * redactions" against a refusal left the reader looking at an unchanged
   * dialog with nothing to read and nothing to do.
   */
  error: string | null;
  sessionId: string;
  onApprove: () => void;
  onCreate: (permission: ShareGrant['permission'], expiresAt: string | null) => void;
  onClose: () => void;
}) {
  /*
    What the scanner actually found, read from the session's redaction masks.

    This is the gate that decides whether a session may leave the archive, so
    anything other than the real findings would make the review worthless.
  */
  const [findings, setFindings] = useState<RedactionFinding[] | null>(null);
  const [findingsError, setFindingsError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || approved) return;
    let cancelled = false;
    void memoarApi.listAnnotations(sessionId)
      .then((response) => { if (!cancelled) setFindings(readFindings(response.items)); })
      .catch((cause: unknown) => {
        if (!cancelled) setFindingsError(cause instanceof Error ? cause.message : 'Findings could not be read');
      });
    return () => { cancelled = true; };
  }, [open, approved, sessionId]);
  // These drive the request. They were uncontrolled inputs whose values were
  // read by nothing, so every choice offered here was discarded.
  const [permission, setPermission] = useState<ShareGrant['permission']>('viewer');
  const [expiry, setExpiry] = useState('7');
  return (
    <Modal
      open={open}
      title={approved ? 'Create share link' : 'Review what leaves your archive'}
      description={approved ? 'The reviewed redaction mask will be applied to every view and import.' : 'Visibility cannot widen until each finding has a decision.'}
      onClose={onClose}
    >
      {!approved ? (
        <>
          <div className="modal-body">
            <div className="review-summary">
              <ScanSearch size={20} />
              <div>
                <strong>
                  {findings === null ? 'Reading findings…' : `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'} in this session`}
                </strong>
                <p>
                  {findings === null
                    ? 'From the secret scan performed when this session was archived.'
                    : findings.length
                      ? 'Every one of these is masked for anyone you share with. The mask is snapshotted against the session as it stands now.'
                      : 'The scan flagged nothing. Approving records that decision against the session as it stands now.'}
                </p>
              </div>
              <Badge className="redaction-findings">{findings?.length ? 'Review required' : 'Review'}</Badge>
            </div>
            {findingsError ? <p role="alert" className="error-note">{findingsError}</p> : null}
            {error ? <p role="alert" className="error-note">{error}</p> : null}

            {/*
              Read-only on purpose: the server masks every finding and the
              review carries no per-finding decision, so a checkbox here would
              be a choice that goes nowhere.
            */}
            <div className="finding-list">
              {(findings ?? []).map((finding) => (
                <div key={finding.id}>
                  <span><strong>{findingLabel(finding.kind)}</strong><code>{finding.preview}</code></span>
                  <Badge>Mask</Badge>
                </div>
              ))}
            </div>
          </div>
          <footer className="modal-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={onApprove}><ShieldCheck size={15} /> Approve redactions</Button></footer>
        </>
      ) : (
        <>
          <div className="modal-body">
            <div className="permission-row">
              <label><input type="radio" name="permission" checked={permission === 'viewer'} onChange={() => setPermission('viewer')} /><span><strong>Viewer</strong><small>Read the redacted session</small></span></label>
              <label><input type="radio" name="permission" checked={permission === 'importer'} onChange={() => setPermission('importer')} /><span><strong>Importer</strong><small>Copy it into another archive</small></span></label>
            </div>
            <label className="field-label">Link expires
              <select value={expiry} onChange={(event) => setExpiry(event.target.value)}>
                <option value="7">In 7 days</option><option value="30">In 30 days</option><option value="never">Never</option>
              </select>
            </label>
            {/*
              Redactions are applied by the server for the life of the link, so
              this states a guarantee rather than offering a choice. It was a
              toggle wired to nothing, which read as an option to turn it off.
            */}
            <p className="redaction-safe"><ShieldCheck size={15} /><span>The reviewed redaction mask is applied for as long as this link is active.</span></p>
            {error ? <p role="alert" className="error-note">{error}</p> : null}
            {link ? <div className="share-link-result"><CopyButton value={link} label="Copy share link" /><code>{link}</code></div> : null}
          </div>
          <footer className="modal-actions">
            <Button variant="ghost" onClick={onClose}>{link ? 'Done' : 'Cancel'}</Button>
            {link ? null : (
              <Button variant="primary" disabled={busy} onClick={() => onCreate(permission, expiresAt(expiry))}>
                <Link2 size={15} /> {busy ? 'Creating…' : 'Create secure link'}
              </Button>
            )}
          </footer>
        </>
      )}
    </Modal>
  );
}
