import { AlertTriangle } from 'lucide-react';
import { memoarApi } from '../../lib/api';
import type { SessionSummary } from '../../lib/types';
import { Button, Modal } from '../../components/ui';

export function DeleteSessionModal({ deleteOpen, setDeleteOpen, deleting, setDeleting, setActionError, session, onDeleted }: {
  deleteOpen: boolean;
  setDeleteOpen: (open: boolean) => void;
  deleting: boolean;
  setDeleting: (deleting: boolean) => void;
  setActionError: (error: string | null) => void;
  session: SessionSummary;
  onDeleted: () => void;
}) {
  return (
    <Modal open={deleteOpen} title="Delete this session?" description="Captured data and raw artifacts enter the configured 30-day recovery window." onClose={() => setDeleteOpen(false)}>
      <div className="modal-body warning-body"><AlertTriangle size={22} /><p>This removes the session from search, collections, share links, and agent memory. Existing exports are not recalled.</p></div>
      <footer className="modal-actions">
        <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
        <Button
          variant="danger"
          disabled={deleting}
          onClick={() => {
            setDeleting(true);
            setActionError(null);
            void memoarApi.deleteSession(session.id)
              .then(() => { setDeleteOpen(false); onDeleted(); })
              .catch((error: unknown) => setActionError(error instanceof Error ? error.message : 'Session could not be deleted'))
              .finally(() => setDeleting(false));
          }}
        >{deleting ? 'Deleting…' : 'Delete session'}</Button>
      </footer>
    </Modal>
  );
}
