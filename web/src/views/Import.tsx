import { useState, type FormEvent } from 'react';
import { Button, PageHeader } from '../components/ui';
import type { ImportProgress, ImportSource } from '../lib/api';
import type { Machine, SessionSummary } from '../lib/types';

/**
 * Every entry here has a parser registered server-side. A format without one
 * uploads, is stored as unknown_format, and never becomes a session, so it is
 * not offered until its parser lands.
 */
const sources: Array<{ value: ImportSource; label: string }> = [
  { value: 'canonical', label: 'Memoar canonical bundle' },
  { value: 'cass', label: 'cass export' },
  { value: 'claude-code', label: 'Claude Code JSONL' },
  { value: 'codex', label: 'Codex rollout JSONL' },
  { value: 'antigravity-cli', label: 'Antigravity CLI archive' },
  { value: 'cursor', label: 'Cursor database export' },
  { value: 'chatgpt-export', label: 'ChatGPT export ZIP' },
];

export function ImportView({ machines, onImport, onOpen }: {
  machines: Machine[];
  onImport: (file: File, source: ImportSource, machineId: string, onProgress: (progress: ImportProgress) => void) => Promise<SessionSummary>;
  onOpen: (session: SessionSummary) => void;
}) {
  const [source, setSource] = useState<ImportSource>('chatgpt-export');
  const [machineId, setMachineId] = useState(machines[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [imported, setImported] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !machineId) return;
    setBusy(true);
    setError(null);
    setImported(null);
    try {
      setImported(await onImport(file, source, machineId, setProgress));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow-page import-page">
      <PageHeader title="Import" />
      <p className="page-intro">Upload a session file or an export. The raw file is kept as uploaded, then parsed into sessions.</p>

      <form className="form-stack form-narrow" onSubmit={(event) => void submit(event)}>
        <label className="field-label">Format<select value={source} onChange={(event) => setSource(event.target.value as ImportSource)}>{sources.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label className="field-label">Capture machine<select value={machineId} onChange={(event) => setMachineId(event.target.value)} disabled={!machines.length}><option value="">Select a registered machine</option>{machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}, {machine.platform}</option>)}</select></label>
        <label className="field-label">File
          <input aria-label="Archive file" className="file-input" type="file" accept=".zip,.json,.jsonl,.db,.md,application/zip,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
        {file ? <p className="field-hint">{file.name}, {file.size.toLocaleString('en')} bytes</p> : null}
        {/* A hint beside the control it explains, not an error: nothing has
            failed, the button is simply not ready yet. */}
        {!machines.length ? <p className="field-hint">Register a machine before importing. Running <code>memoar login</code> on it does that.</p> : null}
        <div className="actions"><Button type="submit" variant="primary" size="sm" disabled={!file || !machineId || busy}>{busy ? 'Importing' : 'Import archive'}</Button></div>
      </form>

      {progress ? <div className="notice" role="status" aria-label="Import progress"><p><strong>{progress.stage}</strong> {progress.detail}</p></div> : null}
      {error ? <div className="notice notice-error" role="alert"><p><strong>Import failed.</strong> {error}</p></div> : null}
      {imported ? (
        <div className="notice">
          <p><strong>{imported.title}</strong> {imported.sourceLabel}, <span className="mono">{imported.workspace}</span></p>
          <Button size="sm" variant="primary" onClick={() => onOpen(imported)}>Open session</Button>
        </div>
      ) : null}
    </div>
  );
}
