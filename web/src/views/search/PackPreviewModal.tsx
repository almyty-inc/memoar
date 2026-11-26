import type { PackResponse } from '../../lib/types';
import { Button, CopyButton, Modal, plural } from '../../components/ui';

export function PackPreviewModal({ packOpen, setPackOpen, packLoading, packError, pack }: {
  packOpen: boolean;
  setPackOpen: (open: boolean) => void;
  packLoading: boolean;
  packError: string | null;
  pack: PackResponse | null;
}) {
  return (
    <Modal open={packOpen} title="Pack preview" description="Cited excerpts from these results, for an agent to read." onClose={() => setPackOpen(false)}>
      <div className="modal-body">
        {packLoading ? <p role="status" className="meta">Building the pack</p> : null}
        {packError ? <p role="alert" className="error-note">{packError}</p> : null}
        {pack ? (
          <div className="pack-preview">
            <p className="meta">{plural(pack.evidence.length, 'excerpt')}, about {pack.tokenEstimate.toLocaleString('en')} tokens</p>
            <p className="pack-excerpt">{pack.evidence[0]?.excerpt ?? 'No evidence matched this query.'}</p>
          </div>
        ) : null}
      </div>
      <footer className="modal-actions">
        {pack ? <CopyButton value={pack.markdown} label="Copy pack" /> : null}
        <Button onClick={() => setPackOpen(false)}>Close</Button>
      </footer>
    </Modal>
  );
}
