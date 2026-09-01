import { BookMarked, FileText, History, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { memoarApi } from '../lib/api';
import type { MemoryDocument, MemoryRevision } from '../lib/types';
import { Badge, Button, EmptyState, formatDate, formatRelative } from '../components/ui';

/** Global first, then one group per project, each sorted by path. */
function group(documents: MemoryDocument[]): { label: string; documents: MemoryDocument[] }[] {
  const groups = new Map<string, MemoryDocument[]>();
  for (const document of documents) {
    const label = document.scope === 'global' ? 'Everywhere on this account' : document.workspacePath ?? 'Project';
    groups.set(label, [...(groups.get(label) ?? []), document]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left === 'Everywhere on this account' ? -1 : right === 'Everywhere on this account' ? 1 : left.localeCompare(right)))
    .map(([label, entries]) => ({ label, documents: [...entries].sort((left, right) => left.path.localeCompare(right.path)) }));
}

export function MemoryView() {
  const [documents, setDocuments] = useState<MemoryDocument[] | null>(null);
  const [selected, setSelected] = useState<{ document: MemoryDocument; revisions: MemoryRevision[] } | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Bumped after a removal, so the list reloads without the caller having to
  // reach into it.
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void memoarApi.listMemory()
      .then((response) => { if (!cancelled) setDocuments(response.items); })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Memory could not be loaded');
      });
    return () => { cancelled = true; };
  }, [reloads]);

  const open = async (documentId: string) => {
    setError(null);
    try {
      const detail = await memoarApi.getMemory(documentId);
      setSelected(detail);
      setShowing(detail.revisions[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That file could not be opened');
    }
  };

  const remove = async (documentId: string) => {
    setError(null);
    try {
      await memoarApi.deleteMemory(documentId);
      if (selected?.document.id === documentId) setSelected(null);
      setReloads((count) => count + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That file could not be removed');
    }
  };

  const filtered = useMemo(() => (documents ?? []).filter((document) =>
    `${document.path} ${document.readers.join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [documents, query]);
  const revision = selected?.revisions.find((entry) => entry.id === showing) ?? selected?.revisions[0] ?? null;

  return (
    <div className="page memory-page">
      <section className="page-heading row-heading">
        <div>
          <div className="eyebrow"><BookMarked size={13} /> Standing instructions</div>
          <h1>Agent memory</h1>
          <p>The files your agents read before they do anything — and every version of them, so you can see what changed and when.</p>
        </div>
        {/*
          A plain field, not the header's SearchField: that one carries a ⌘K
          hint for the shortcut that opens archive search, and repeating it here
          promises a key that does something else entirely.
        */}
        <label className="memory-filter">
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by path or tool" aria-label="Filter memory files" />
        </label>
      </section>

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      {documents && documents.length === 0 ? (
        <EmptyState
          title="No memory files captured yet"
          body="The capture agent uploads CLAUDE.md, AGENTS.md, .goosehints and the rest for the projects this account already has sessions in. Run a sync to collect them."
        />
      ) : null}

      <div className="memory-layout">
        <div className="memory-list">
          {group(filtered).map((section) => (
            <section key={section.label}>
              <h2>{section.label}</h2>
              {section.documents.map((document) => (
                <article key={document.id} className={document.id === selected?.document.id ? 'memory-entry selected' : 'memory-entry'}>
                  <button type="button" onClick={() => void open(document.id)}>
                    <FileText size={15} />
                    <span className="memory-entry-title">{document.title}</span>
                    <span className="memory-entry-path">{document.path}</span>
                  </button>
                  <div className="memory-entry-readers">
                    {document.readers.map((reader) => <Badge key={reader}>{reader}</Badge>)}
                  </div>
                  <footer>
                    <span>Read {formatRelative(document.capturedAt)}</span>
                    <Button variant="ghost" size="sm" onClick={() => void remove(document.id)} aria-label={`Remove ${document.path}`}>
                      <Trash2 size={14} /> Remove
                    </Button>
                  </footer>
                </article>
              ))}
            </section>
          ))}
        </div>

        {selected ? (
          <aside className="memory-detail">
            <header>
              <h2>{selected.document.title}</h2>
              <p>{selected.document.path}</p>
            </header>
            <div className="memory-revisions">
              <h3><History size={14} /> {selected.revisions.length} {selected.revisions.length === 1 ? 'version' : 'versions'}</h3>
              {selected.revisions.map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  className={entry.id === revision?.id ? 'selected' : undefined}
                  onClick={() => setShowing(entry.id)}
                >
                  {index === 0 ? 'Current' : formatDate(entry.capturedAt)}
                  <span>{entry.size} bytes</span>
                </button>
              ))}
            </div>
            <pre className="memory-text">{revision?.text ?? ''}</pre>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
