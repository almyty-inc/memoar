import { useMemo, useState, type FormEvent } from 'react';
import { memoarApi } from '../lib/api';
import type { Collection as CollectionType, SessionSummary } from '../lib/types';
import { Button, EmptyState, Modal, PageHeader, formatRelative, plural } from '../components/ui';
import { readDraft, writeDraft, type Draft } from './collections/draft';

export function CollectionsView({ collections, onOpen, onCreate }: {
  collections: CollectionType[];
  onOpen: (session: SessionSummary) => void;
  onCreate: (name: string, description: string) => Promise<void>;
}) {
  // An interrupted form reopens on its draft, so the recovery is visible.
  const [restored] = useState(readDraft);
  const [createOpen, setCreateOpen] = useState(restored !== null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ id: string; name: string; sessions: SessionSummary[] } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(restored?.name ?? '');
  const [description, setDescription] = useState(restored?.description ?? '');

  // Membership lives server-side, so it is fetched rather than guessed.
  const openCollection = async (collectionId: string) => {
    setOpeningId(collectionId);
    setOpenError(null);
    try {
      const members = await memoarApi.listCollectionSessions(collectionId);
      const collection = collections.find((entry) => entry.id === collectionId);
      setOpened({ id: collectionId, name: collection?.name ?? 'Collection', sessions: members });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : 'Collection could not be opened');
    } finally {
      setOpeningId(null);
    }
  };

  const edit = (next: Draft) => {
    setName(next.name);
    setDescription(next.description);
    writeDraft(next);
  };

  const closeCreate = () => {
    setCreateOpen(false);
    setName('');
    setDescription('');
    writeDraft(null);
  };

  const filtered = useMemo(() => collections.filter((collection) =>
    `${collection.name} ${collection.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [collections, query]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    await onCreate(name.trim(), description.trim());
    setSaving(false);
    closeCreate();
  };

  return (
    <div className="page collections-page">
      <PageHeader title="Collections" count={plural(collections.length, 'collection')}>
        {collections.length > 3 ? (
          <input className="filter-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter" aria-label="Filter collections" />
        ) : null}
        <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>New collection</Button>
      </PageHeader>

      {openError ? <p role="alert" className="error-note">{openError}</p> : null}

      {collections.length === 0 ? (
        <EmptyState title="No collections yet." body="Group sessions about one project or question, then add sessions from their More menu." />
      ) : (
        <div className="row-list">
          <div className="row-head"><span className="row-main">Name</span><span className="col-w-sessions">Sessions</span><span className="col-w-updated">Updated</span></div>
          {filtered.map((collection) => (
            <button key={collection.id} type="button" className="row row-button" onClick={() => void openCollection(collection.id)} aria-label={`Open ${collection.name}`}>
              <span className="row-main"><strong>{collection.name}</strong>{collection.description ? <span className="muted"> {collection.description}</span> : null}</span>
              <span className="row-meta col-w-sessions">{openingId === collection.id ? 'Opening' : plural(collection.sessionCount, 'session')}</span>
              <span className="row-meta col-w-updated">{formatRelative(collection.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}

      <Modal open={opened !== null} title={opened?.name ?? 'Collection'} onClose={() => setOpened(null)}>
        <div className="modal-body">
          {opened?.sessions.length === 0 ? <p className="empty-note">This collection has no sessions yet.</p> : (
            <div className="choice-list">
              {opened?.sessions.map((session) => (
                <button key={session.id} type="button" className="choice" onClick={() => { setOpened(null); onOpen(session); }}>
                  <strong>{session.title}</strong>
                  <small>{session.sourceLabel}, {formatRelative(session.updatedAt)}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <footer className="modal-actions"><Button onClick={() => setOpened(null)}>Close</Button></footer>
      </Modal>

      <Modal open={createOpen} title="New collection" description="Private until you share it with a team." onClose={closeCreate}>
        <form onSubmit={(event) => void submit(event)}>
          <div className="modal-body">
            {restored ? <p className="field-hint">Restored from before you were asked to sign in again.</p> : null}
            <label className="field-label">Name<input value={name} onChange={(event) => edit({ name: event.target.value, description })} placeholder="Retrieval quality" autoFocus required /></label>
            <label className="field-label">Description<textarea value={description} onChange={(event) => edit({ name, description: event.target.value })} placeholder="What belongs here" rows={3} /></label>
          </div>
          <footer className="modal-actions"><Button variant="ghost" onClick={closeCreate}>Cancel</Button><Button type="submit" variant="primary" disabled={saving}>{saving ? 'Creating' : 'Create collection'}</Button></footer>
        </form>
      </Modal>
    </div>
  );
}
