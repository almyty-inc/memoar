import type { PackResponse } from '../../lib/types';
import { Badge, Button, CopyButton, Modal } from '../../components/ui';

export function PackPreviewModal({ packOpen, setPackOpen, packLoading, packError, pack }: {
  packOpen: boolean;
  setPackOpen: (open: boolean) => void;
  packLoading: boolean;
  packError: string | null;
  pack: PackResponse | null;
}) {
  return (
    <Modal open={packOpen} title="Pack preview" description="A cited, extractive bundle built from these results." onClose={() => setPackOpen(false)}>
      <div className="modal-body pack-modal-body">
        {packLoading ? <p role="status">Building cited preview…</p> : null}
        {packError ? <p role="alert" className="error-note">{packError}</p> : null}

        {pack ? (
          <div className="pack-preview-card">
            <div><Badge>{pack.evidence.length} excerpts</Badge><span>Estimated {pack.tokenEstimate.toLocaleString()} tokens</span></div>
            <h3>{pack.query}</h3>
            <p>{pack.evidence[0]?.excerpt ?? 'No evidence matched this query.'}</p>
          </div>
        ) : null}
      </div>
      <footer className="modal-actions">
        {pack ? <CopyButton value={pack.markdown} label="Copy pack" /> : null}
        <Button variant="ghost" onClick={() => setPackOpen(false)}>Close</Button>
      </footer>
    </Modal>
  );
}
