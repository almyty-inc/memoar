import {
  ArrowRight,
  BookOpen,
  ChevronRight,
  LibraryBig as Collection,
  FileDown,
  FolderPlus,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import type { Collection as CollectionType, SessionSummary } from '../lib/types';
import { Badge, Button, IconButton, Modal, SourceBadge, formatRelative } from '../components/ui';

export function CollectionsView({ collections, sessions, onOpen, onCreate }: {
  collections: CollectionType[];
  sessions: SessionSummary[];
  onOpen: (session: SessionSummary) => void;
  onCreate: (name: string, description: string) => Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
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
        <div><strong>12</strong><span>distilled notes</span></div>
        <div className="collection-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter collections" aria-label="Filter collections" /></div>
      </section>

      <div className="collection-grid">
        {filtered.map((collection, index) => {
          const members = sessions.filter((session) => collection.members.includes(session.id));
          return (
            <article className="collection-card" key={collection.id}>
              <div className="collection-color" style={{ background: collection.color }} />
              <header>
                <span className="collection-icon" style={{ color: collection.color }}><BookOpen size={18} /></span>
                <IconButton label={`More options for ${collection.name}`}><MoreHorizontal size={17} /></IconButton>
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
                {!members.length ? <p>No demo sessions in this collection.</p> : null}
              </div>
              <footer>
                <div>{index < 2 ? <Badge><Users size={12} /> Personal</Badge> : <Badge>Private</Badge>}</div>
                <Button variant="ghost" size="sm">Open collection <ArrowRight size={14} /></Button>
              </footer>
            </article>
          );
        })}

        <button className="new-collection-card" type="button" onClick={() => setCreateOpen(true)}>
          <span><FolderPlus size={22} /></span><strong>Create a collection</strong><p>Curate sessions, notes, and pins around a project or topic.</p>
        </button>
      </div>

      <section className="notes-panel">
        <div className="notes-heading"><span><Sparkles size={17} /></span><div><h2>Durable notes</h2><p>Distilled decisions and working solutions, linked back to their source turns.</p></div><Button size="sm">Review notes <ArrowRight size={14} /></Button></div>
        <div className="note-row"><div><Badge>Decision</Badge><strong>Keep annotations separate from captured session data</strong><p>Immutable capture allows safe re-parsing and predictable sharing masks.</p></div><span>3 sources</span><Button variant="ghost" size="sm"><FileDown size={14} /> AGENTS.md fragment</Button></div>
      </section>

      <Modal open={createOpen} title="Create collection" description="Collections stay private until you add them to a team space." onClose={() => setCreateOpen(false)}>
        <form onSubmit={(event) => void submit(event)}>
          <div className="modal-body form-stack">
            <label className="field-label">Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: Retrieval quality" autoFocus required /></label>
            <label className="field-label">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What belongs here?" rows={3} /></label>
            <div className="color-choices" aria-label="Collection color">{['#d6ff78', '#7dd3fc', '#f0a6ca', '#c4b5fd'].map((color) => <button type="button" key={color} style={{ background: color }} aria-label={`Use ${color}`} />)}</div>
          </div>
          <footer className="modal-actions"><Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={saving}>{saving ? 'Creating…' : 'Create collection'}</Button></footer>
        </form>
      </Modal>
    </div>
  );
}
