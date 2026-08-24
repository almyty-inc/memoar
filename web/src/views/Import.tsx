import { AlertCircle, ArrowRight, CheckCircle2, FileArchive, ShieldCheck, UploadCloud } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button } from '../components/ui';
import type { ImportProgress, ImportSource } from '../lib/api';
import type { Machine, SessionSummary } from '../lib/types';

/**
 * Every entry here must have a parser registered server-side. Offering a format
 * we cannot parse does not fail: the upload succeeds, the artifact is stored as
 * unknown_format, and the user watches a progress bar until it times out with
 * nothing to show. claude-ai, gemini, mistral, and perplexity exports were
 * listed here without parsers and did exactly that — they return when the
 * parsers land, not before.
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
    <div className="page import-page">
      <section className="page-heading row-heading">
        <div><div className="eyebrow"><FileArchive size={13} /> Portable archive intake</div><h1>Import sessions</h1><p>Preserve native bytes first, then parse them into branch-aware canonical sessions.</p></div>
        <Badge><ShieldCheck size={12} /> Private by default</Badge>
      </section>

      <section className="settings-section import-panel">
        <header><div><h2>Choose an archive</h2><p>Native stores, Memoar bundles, cass exports, and consumer ZIPs use the same raw-first ingest path.</p></div></header>
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <label className="field-label">Format<select value={source} onChange={(event) => setSource(event.target.value as ImportSource)}>{sources.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className="field-label">Capture machine<select value={machineId} onChange={(event) => setMachineId(event.target.value)} disabled={!machines.length}><option value="">Select a registered machine</option>{machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name} · {machine.platform}</option>)}</select></label>
          <label className="field-label import-file">Archive file<input aria-label="Archive file" type="file" accept=".zip,.json,.jsonl,.db,.md,application/zip,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><span><UploadCloud size={18} />{file ? `${file.name} · ${file.size.toLocaleString()} bytes` : 'Select an archive file'}</span></label>
          {!machines.length ? <p role="alert"><AlertCircle size={14} /> Register a machine before submitting an ingest manifest.</p> : null}
          <Button type="submit" variant="primary" disabled={!file || !machineId || busy}>{busy ? 'Importing…' : 'Import archive'} <ArrowRight size={14} /></Button>
        </form>
      </section>

      {progress ? <section className="privacy-banner" role="status"><span>{progress.stage === 'ready' ? <CheckCircle2 size={20} /> : <UploadCloud size={20} />}</span><div><strong>{progress.stage}</strong><p>{progress.detail}</p></div></section> : null}
      {error ? <section className="privacy-banner" role="alert"><span><AlertCircle size={20} /></span><div><strong>Import failed</strong><p>{error}</p></div></section> : null}
      {imported ? <section className="settings-section"><header><div><h2>{imported.title}</h2><p>{imported.sourceLabel} · {imported.workspace}</p></div><Button variant="primary" onClick={() => onOpen(imported)}>Open imported session <ArrowRight size={14} /></Button></header></section> : null}
    </div>
  );
}
