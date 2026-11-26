import type { Collection as CollectionRecord } from '../../lib/types';
import { Button, Modal, plural } from '../../components/ui';

export function CollectionModal({ collectionOpen, setCollectionOpen, collections, busyAction, addToCollection, actionError }: {
  collectionOpen: boolean;
  setCollectionOpen: (open: boolean) => void;
  collections: CollectionRecord[];
  busyAction: string | null;
  addToCollection: (collectionId: string) => Promise<void>;
  actionError: string | null;
}) {
  return (
    <Modal open={collectionOpen} title="Add to collection" onClose={() => setCollectionOpen(false)}>
      <div className="modal-body">
        <div className="choice-list">
          {collections.map((collection) => (
            <button key={collection.id} type="button" className="choice" disabled={busyAction === 'collection'} onClick={() => void addToCollection(collection.id)}>
              <strong>{collection.name}</strong>
              <small>{plural(collection.sessionCount, 'session')}</small>
            </button>
          ))}
        </div>
        {actionError ? <p role="alert" className="error-note">{actionError}</p> : null}
      </div>
      <footer className="modal-actions"><Button variant="ghost" onClick={() => setCollectionOpen(false)}>Cancel</Button></footer>
    </Modal>
  );
}
