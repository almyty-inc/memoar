import { useEffect, useState } from 'react';
import { memoarApi } from '../../lib/api';
import type { Annotation, ShareGrant } from '../../lib/types';
import { Button, CopyButton, Modal, plural } from '../../components/ui';

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
  /** Why the last attempt did not work, said inside the dialog that covers the page. */
  error: string | null;
  sessionId: string;
  onApprove: () => void;
  onCreate: (permission: ShareGrant['permission'], expiresAt: string | null) => void;
  onClose: () => void;
}) {
  /*
    What the scanner actually found, read from the session's redaction masks.
    This is the gate that decides whether a session may leave the archive.
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
  const [permission, setPermission] = useState<ShareGrant['permission']>('viewer');
  const [expiry, setExpiry] = useState('7');

  return (
    <Modal
      open={open}
      title={approved ? 'Create share link' : 'Review what leaves your archive'}
      description={approved ? 'The reviewed mask applies to every view and import through this link.' : 'Every finding below is masked for anyone you share with.'}
      onClose={onClose}
    >
      {!approved ? (
        <>
          <div className="modal-body">
            <p>
              <strong>{findings === null ? 'Reading findings' : `${plural(findings.length, 'finding')} in this session`}</strong>{' '}
              <span className="muted">
                {findings === null
                  ? 'From the secret scan made when the session was archived.'
                  : findings.length
                    ? 'The mask is recorded against the session as it stands now.'
                    : 'The scan flagged nothing. Approving records that decision against the session as it stands now.'}
              </span>
            </p>
            {findingsError ? <p role="alert" className="error-note">{findingsError}</p> : null}
            {error ? <p role="alert" className="error-note">{error}</p> : null}
            {/* Read-only on purpose: the server masks every finding and the
                review carries no per-finding decision. */}
            {findings && findings.length > 0 ? (
              <div className="row-list">
                {findings.map((finding) => (
                  <div className="row" key={finding.id}>
                    <span className="row-main">{findingLabel(finding.kind)}</span>
                    <code className="meta">{finding.preview}</code>
                    <span className="row-meta">Masked</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <footer className="modal-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={onApprove}>Approve redactions</Button></footer>
        </>
      ) : (
        <>
          <div className="modal-body">
            <div className="choice-list" role="radiogroup" aria-label="Permission">
              <label className="choice"><input type="radio" name="permission" checked={permission === 'viewer'} onChange={() => setPermission('viewer')} /><strong>Viewer</strong><small>Read the redacted session</small></label>
              <label className="choice"><input type="radio" name="permission" checked={permission === 'importer'} onChange={() => setPermission('importer')} /><strong>Importer</strong><small>Copy it into another archive</small></label>
            </div>
            <label className="field-label">Link expires
              <select value={expiry} onChange={(event) => setExpiry(event.target.value)}>
                <option value="7">In 7 days</option><option value="30">In 30 days</option><option value="never">Never</option>
              </select>
            </label>
            {error ? <p role="alert" className="error-note">{error}</p> : null}
            {link ? <div className="command"><code>{link}</code><CopyButton value={link} label="Copy share link" /></div> : null}
          </div>
          <footer className="modal-actions">
            <Button variant="ghost" onClick={onClose}>{link ? 'Done' : 'Cancel'}</Button>
            {link ? null : (
              <Button variant="primary" disabled={busy} onClick={() => onCreate(permission, expiresAt(expiry))}>
                {busy ? 'Creating' : 'Create secure link'}
              </Button>
            )}
          </footer>
        </>
      )}
    </Modal>
  );
}
