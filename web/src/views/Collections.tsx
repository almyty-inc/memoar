import {
  ArrowRight,
  BookOpen,
  LibraryBig as Collection,
  FolderPlus,
  Plus,
  Search,
  Users,
} from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { memoarApi } from '../lib/api';
import type { Collection as CollectionType, SessionSummary } from '../lib/types';
import { Badge, Button, Modal, formatRelative } from '../components/ui';

const DRAFT_KEY = 'memoar.collections.draft';

interface Draft { name: string; description: string }

/**
 * What was typed into the create form and not yet saved.
 *
 * A browser token lives an hour and is not refreshed, so a form opened at
 * minute 58 and submitted at minute 61 used to unmount on the 401 with both
 * fields gone and nothing said. The draft is kept for the tab, so signing in
 * again brings the reader back to the form with their words still in it. It is
 * cleared the moment they save or cancel: only an interruption preserves it.
 */
function readDraft(): Draft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { name, description } = parsed as Partial<Draft>;
    if (typeof name !== 'string' || typeof description !== 'string') return null;
    return name || description ? { name, description } : null;
  } catch {
    return null;
  }
}

function writeDraft(draft: Draft | null): void {
  try {
    if (draft && (draft.name || draft.description)) window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // A blocked or full store should cost the draft, not the form.
  }
}

export function CollectionsView({ collections, onOpen, onCreate }: {
  collections: CollectionType[];
  onOpen: (session: SessionSummary) => void;
  onCreate: (name: string, description: string) => Promise<void>;
}) {
  // An unfinished form reopens on the draft that was interrupted, so the
  // recovery is something the reader can see rather than something they have to
  // be told about.
  const [restored] = useState(readDraft);
  const [createOpen, setCreateOpen] = useState(restored !== null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ id: string; name: string; sessions: SessionSummary[] } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  // Membership lives server-side, so it is fetched rather than guessed from
  // whatever sessions happen to be loaded.
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
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(restored?.name ?? '');
  const [description, setDescription] = useState(restored?.description ?? '');

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
      <section className="page-heading row-heading">
        <div><div className="eyebrow"><Collection size={13} /> Curated memory</div><h1>Collections</h1><p>Group related sessions and durable notes into a focused memory surface.</p></div>
        <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={16} /> New collection</Button>
      </section>

      <section className="collection-overview">
        <div><strong>{collections.length}</strong><span>collections</span></div>
        <div><strong>{collections.reduce((count, collection) => count + collection.sessionCount, 0)}</strong><span>session memberships</span></div>
        <div className="collection-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter collections" aria-label="Filter collections" /></div>
      </section>

      <div className="collection-grid">
        {filtered.map((collection) => {
          // Membership is not in the list response, so the preview here was
          // built from a members array the client filled with nothing: a card
          // could read "3 sessions" and then say the collection was empty.
          // Opening one fetches the real membership.
          return (
            <article className="collection-card" key={collection.id}>
              <div className="collection-color" style={{ background: collection.color }} />
              <header>
                <span className="collection-icon" style={{ color: collection.color }}><BookOpen size={18} /></span>
              </header>
              <h2>{collection.name}</h2>
              <p>{collection.description}</p>
              <div className="collection-count"><strong>{collection.sessionCount}</strong> sessions <span>·</span> Updated {formatRelative(collection.updatedAt)}</div>
              {collection.sessionCount === 0 ? <p className="collection-empty">No sessions in this collection yet.</p> : null}
              <footer>
                {/*
                  The badge here was decided by list position — the first two
                  collections were labelled "Personal" and the rest "Private",
                  which described nothing. It shows the real membership count.
                */}
                <div><Badge><Users size={12} /> {collection.sessionCount} {collection.sessionCount === 1 ? 'session' : 'sessions'}</Badge></div>
                <Button variant="ghost" size="sm" onClick={() => void openCollection(collection.id)}>
                  {openingId === collection.id ? 'Opening…' : 'Open collection'} <ArrowRight size={14} />
                </Button>
              </footer>
            </article>
          );
        })}

        {openError ? <p role="alert" className="error-note">{openError}</p> : null}

        <button className="new-collection-card" type="button" onClick={() => setCreateOpen(true)}>
          <span><FolderPlus size={22} /></span><strong>Create a collection</strong><p>Curate sessions, notes, and pins around a project or topic.</p>
        </button>
      </div>


      <Modal open={opened !== null} title={opened?.name ?? 'Collection'} description="Sessions in this collection." onClose={() => setOpened(null)}>
        <div className="modal-body">
          {opened?.sessions.length === 0 ? <p className="empty-note">This collection has no sessions yet.</p> : null}
          <div className="collection-picker">
            {opened?.sessions.map((session) => (
              <button key={session.id} type="button" className="collection-choice" onClick={() => { setOpened(null); onOpen(session); }}>
                <strong>{session.title}</strong>
                <small>{session.sourceLabel} · {formatRelative(session.updatedAt)}</small>
              </button>
            ))}
          </div>
        </div>
        <footer className="modal-actions"><Button variant="ghost" onClick={() => setOpened(null)}>Close</Button></footer>
      </Modal>

      <Modal open={createOpen} title="Create collection" description="Collections stay private until you add them to a team space." onClose={closeCreate}>
        <form onSubmit={(event) => void submit(event)}>
          <div className="modal-body form-stack">
            {restored ? <p className="field-hint">Restored from before you were asked to sign in again.</p> : null}
            <label className="field-label">Name<input value={name} onChange={(event) => edit({ name: event.target.value, description })} placeholder="Example: Retrieval quality" autoFocus required /></label>
            <label className="field-label">Description<textarea value={description} onChange={(event) => edit({ name, description: event.target.value })} placeholder="What belongs here?" rows={3} /></label>
          </div>
          <footer className="modal-actions"><Button variant="ghost" onClick={closeCreate}>Cancel</Button><Button type="submit" variant="primary" disabled={saving}>{saving ? 'Creating…' : 'Create collection'}</Button></footer>
        </form>
      </Modal>
    </div>
  );
}
