import { useEffect, useMemo, useState } from 'react';
import { memoarApi } from '../lib/api';
import type { MemoryDocument, MemoryRevision } from '../lib/types';
import { Button, EmptyState, PageHeader, RedactionBadge, cn, formatDate, formatRelative, plural } from '../components/ui';
import { languageForPath } from '../lib/highlight';
import { CodeBlock } from './session-detail/CodeBlock';
import { MemoryConvertPanel } from './MemoryConvert';
import { MemoryRedactionPanel } from './MemoryRedaction';

const GLOBAL = 'Everywhere on this account';

/** Global first, then one group per project, each sorted by path. */
function group(documents: MemoryDocument[]): { label: string; documents: MemoryDocument[] }[] {
  const groups = new Map<string, MemoryDocument[]>();
  for (const document of documents) {
    const label = document.scope === 'global' ? GLOBAL : document.workspacePath ?? 'Project';
    groups.set(label, [...(groups.get(label) ?? []), document]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left === GLOBAL ? -1 : right === GLOBAL ? 1 : left.localeCompare(right)))
    .map(([label, entries]) => ({ label, documents: [...entries].sort((left, right) => left.path.localeCompare(right.path)) }));
}

/**
 * The instruction files agents read before they do anything, and every
 * version of them: a list on the left, the selected file on the right.
 */
export function MemoryView() {
  const [documents, setDocuments] = useState<MemoryDocument[] | null>(null);
  const [selected, setSelected] = useState<{ document: MemoryDocument; revisions: MemoryRevision[] } | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  // Bumped after a removal, so the list reloads.
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
    setReviewError(null);
    try {
      const detail = await memoarApi.getMemory(documentId);
      setSelected(detail);
      setShowing(detail.revisions[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That file could not be opened');
    }
  };

  /**
   * Records the review and shows the status the server came back with. A
   * review of a version the agent has since replaced is refused, and the
   * status stays as it was.
   */
  const review = async (document: MemoryDocument) => {
    setReviewing(true);
    setReviewError(null);
    try {
      const reviewed = await memoarApi.reviewMemory(document.id, document.contentHash);
      setSelected((current) => (current && current.document.id === reviewed.id ? { ...current, document: reviewed } : current));
      setDocuments((current) => current?.map((entry) => (entry.id === reviewed.id ? reviewed : entry)) ?? current);
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : 'The review could not be recorded');
    } finally {
      setReviewing(false);
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
      <PageHeader title="Memory" count={documents ? plural(documents.length, 'file') : undefined}>
        <input className="filter-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by path or tool" aria-label="Filter memory files" />
      </PageHeader>

      {error ? <p role="alert" className="error-note">{error}</p> : null}

      {documents && documents.length === 0 ? (
        <EmptyState
          title="No memory files captured yet"
          body={<>CLAUDE.md, AGENTS.md, .goosehints and the rest are collected for projects that already have sessions. Run <code>memoar sync</code> to collect them.</>}
        />
      ) : null}

      <div className="memory-layout">
        <div className="memory-list">
          {group(filtered).map((section) => (
            <section key={section.label}>
              <h2 className={cn('memory-group', section.label !== GLOBAL && 'mono')}>{section.label}</h2>
              <div className="row-list">
                {section.documents.map((document) => (
                  <div key={document.id} className={cn('row memory-row', document.id === selected?.document.id && 'row-selected')}>
                    <button type="button" className="memory-open" onClick={() => void open(document.id)}>
                      <span className="memory-title">{document.title}</span>
                      <span className="memory-path">{document.path}</span>
                    </button>
                    <span className="memory-readers">
                      {document.readers.map((reader) => <span key={reader} className="badge badge-box">{reader}</span>)}
                    </span>
                    {document.redactionStatus === 'clear' ? null : <RedactionBadge status={document.redactionStatus} />}
                    <span className="row-meta" title={`Read ${formatRelative(document.capturedAt)}`}>{formatRelative(document.capturedAt)}</span>
                    <Button variant="ghost" size="sm" onClick={() => void remove(document.id)} aria-label={`Remove ${document.path}`}>Remove</Button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        {selected ? (
          <aside className="memory-detail" aria-label={selected.document.path}>
            <header>
              <h2>{selected.document.title}</h2>
              <p className="mono meta">{selected.document.path}</p>
            </header>
            <MemoryRedactionPanel document={selected.document} busy={reviewing} error={reviewError} onReview={() => void review(selected.document)} />
            <div className="memory-revisions" role="group" aria-label={plural(selected.revisions.length, 'version')}>
              {selected.revisions.map((entry, index) => (
                <button key={entry.id} type="button" aria-pressed={entry.id === revision?.id} className={cn('chip', entry.id === revision?.id && 'active')} onClick={() => setShowing(entry.id)}>
                  {index === 0 ? 'Current' : formatDate(entry.capturedAt)}
                  <span className="meta">{entry.size.toLocaleString('en')} B</span>
                </button>
              ))}
            </div>
            <CodeBlock code={revision?.text ?? ''} language={languageForPath(selected.document.path) ?? 'markdown'} className="code-block memory-text" />
            <MemoryConvertPanel document={selected.document} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
