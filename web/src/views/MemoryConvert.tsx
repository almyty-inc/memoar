import { ArrowLeftRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui';
import { memoarApi } from '../lib/api';
import { MEMORY_DIALECTS, type MemoryConversionBundle, type MemoryDialect, type MemoryDocument } from '../lib/types';

/**
 * Porting one tool's standing instructions into another's dialect.
 *
 * The same text at the other tool's path — nothing rewritten, no frontmatter
 * invented, no model involved. What this panel shows is what *would* be
 * written: the paths, and which of your files went into each one. Writing it
 * onto a machine is `memoar memory convert --here`, deliberately, because that
 * is a change to somebody's disk and it belongs where the disk is.
 *
 * Every dialect is offered rather than only the ones with a file in this scope.
 * Which tools have a user-wide file and which only a project one is the
 * server's table; keeping a copy of it here would be a fourth place for it to
 * drift, and the refusal the archive sends back says exactly what is missing.
 */
export function MemoryConvertPanel({ document }: { document: MemoryDocument }) {
  const [source, setSource] = useState(document.readers[0] ?? 'claude-code');
  const [target, setTarget] = useState<MemoryDialect>('codex');
  const [bundle, setBundle] = useState<MemoryConversionBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = async () => {
    setBusy(true);
    setError(null);
    setBundle(null);
    try {
      setBundle(await memoarApi.convertMemory({
        source,
        target,
        scope: document.scope,
        ...(document.workspacePath ? { workspacePath: document.workspacePath } : {}),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That conversion could not be prepared');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="memory-convert">
      <h3><ArrowLeftRight size={14} /> Port to another tool</h3>
      <p>
        The same text, at the path {target} reads. Nothing is rewritten and nothing is written to
        a machine here.
      </p>
      <div className="memory-convert-controls">
        <label>
          From
          <select value={source} onChange={(event) => setSource(event.target.value)} aria-label="Convert from">
            {document.readers.map((reader) => <option key={reader} value={reader}>{reader}</option>)}
          </select>
        </label>
        <label>
          To
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value as MemoryDialect)}
            aria-label="Convert to"
          >
            {MEMORY_DIALECTS.filter((dialect) => dialect !== source)
              .map((dialect) => <option key={dialect} value={dialect}>{dialect}</option>)}
          </select>
        </label>
        <Button size="sm" onClick={() => void preview()} disabled={busy}>
          {busy ? 'Preparing…' : 'Show the port'}
        </Button>
      </div>

      {error ? <p role="alert" className="error-note">{error}</p> : null}

      {bundle ? (
        <div className="memory-convert-result">
          <p>
            {bundle.report.documents} {bundle.report.documents === 1 ? 'file' : 'files'}
            {bundle.report.concatenated ? ', joined into one with a note saying where each part came from' : ''}
          </p>
          <ul>
            {bundle.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                <span>{file.size} bytes</span>
                <span className="memory-convert-sources">{file.sources.join(', ')}</span>
              </li>
            ))}
          </ul>
          <p className="memory-convert-command">
            <code>memoar memory convert --source {bundle.source} --target {bundle.target} --scope {bundle.scope} --here</code>
          </p>
        </div>
      ) : null}
    </div>
  );
}
