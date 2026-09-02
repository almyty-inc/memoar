import {
  ArrowRight,
  BookOpen,
  ChevronRight,
  LibraryBig as Collection,
  FolderPlus,
  Plus,
  Search,
  Users,
} from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { memoarApi } from '../lib/api';
import type { Collection as CollectionType, SessionSummary } from '../lib/types';
import { Badge, Button, Modal, SourceBadge, formatRelative } from '../components/ui';

export function CollectionsView({ collections, sessions, onOpen, onCreate }: {
  collections: CollectionType[];
  sessions: SessionSummary[];
  onOpen: (session: SessionSummary) => void;
  onCreate: (name: string, description: string) => Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ id: string; name: string; sessions: SessionSummary[] } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  // "Open collection" did nothing. Membership lives server-side, so it is
  // fetched rather than guessed from whatever sessions happen to be loaded.
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
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const filtered = useMemo(() => collections.filter((collection) =>
    `${collection.name} ${collection.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [collections, query]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    await onCreate(name.trim(), description.trim());
    setSaving(false);
    setName('');
    setDescription('');
    setCreateOpen(false);
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
          const members = sessions.filter((session) => collection.members.includes(session.id));
          return (
            <article className="collection-card" key={collection.id}>
              <div className="collection-color" style={{ background: collection.color }} />
              <header>
                <span className="collection-icon" style={{ color: collection.color }}><BookOpen size={18} /></span>
              </header>
              <h2>{collection.name}</h2>
              <p>{collection.description}</p>
              <div className="collection-count"><strong>{collection.sessionCount}</strong> sessions <span>·</span> Updated {formatRelative(collection.updatedAt)}</div>
              <div className="collection-members">
                {members.slice(0, 3).map((session) => (
                  <button key={session.id} type="button" onClick={() => onOpen(session)}>
                    <SourceBadge source={session.source} label={session.sourceLabel} />
                    <span>{session.title}</span><ChevronRight size={14} />
                  </button>
                ))}
                {!members.length ? <p>No sessions in this collection yet.</p> : null}
              </div>
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

        {openError ? <p role="alert">{openError}</p> : null}
        <button className="new-collection-card" type="button" onClick={() => setCreateOpen(true)}>
          <span><FolderPlus size={22} /></span><strong>Create a collection</strong><p>Curate sessions, notes, and pins around a project or topic.</p>
        </button>
      </div>

      {/*
        A "Durable notes" panel used to sit here showing one hardcoded note —
        "Keep annotations separate from captured session data", attributed to
        "3 sources" — with Review notes and AGENTS.md fragment buttons that did
        nothing. None of it came from the archive. Distillation is a real
        feature and this panel will return when it is wired to it.
      */}

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

      <Modal open={createOpen} title="Create collection" description="Collections stay private until you add them to a team space." onClose={() => setCreateOpen(false)}>
        <form onSubmit={(event) => void submit(event)}>
          <div className="modal-body form-stack">
            <label className="field-label">Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: Retrieval quality" autoFocus required /></label>
            <label className="field-label">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What belongs here?" rows={3} /></label>
            {/*
              A row of four colour swatches used to sit here with no click
              handler and no field to write to: choosing one did nothing, and
              the collection was created with whatever colour the server picked.
              A control that cannot change anything is worse than no control.
            */}
          </div>
          <footer className="modal-actions"><Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={saving}>{saving ? 'Creating…' : 'Create collection'}</Button></footer>
        </form>
      </Modal>
    </div>
  );
}
