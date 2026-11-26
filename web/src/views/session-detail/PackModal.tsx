import type { PackResponse } from '../../lib/types';
import { Button, CopyButton, Modal, plural } from '../../components/ui';

export function PackModal({ packOpen, setPackOpen, setConvertOpen, packBudget, setPackBudget, packFreshness, setPackFreshness, packLoading, openPack, pack, actionError }: {
  packOpen: boolean;
  setPackOpen: (open: boolean) => void;
  setConvertOpen: (open: boolean) => void;
  packBudget: number;
  setPackBudget: (budget: number) => void;
  packFreshness: 'strict' | 'mixed';
  setPackFreshness: (freshness: 'strict' | 'mixed') => void;
  packLoading: boolean;
  openPack: () => Promise<void>;
  pack: PackResponse | null;
  actionError: string | null;
}) {
  const first = pack?.evidence[0];
  return (
    <Modal open={packOpen} title="Pack preview" description="Cited excerpts that fit the token budget." onClose={() => setPackOpen(false)}>
      <div className="modal-body">
        <div className="form-row">
          <label className="field-label">Token budget<input type="number" value={packBudget} min={64} max={32000} onChange={(event) => setPackBudget(Number(event.target.value))} /></label>
          <label className="field-label">Freshness
            <select value={packFreshness} onChange={(event) => setPackFreshness(event.target.value === 'strict' ? 'strict' : 'mixed')}>
              <option value="mixed">Mixed, flag stale</option>
              <option value="strict">Strict, fresh only</option>
            </select>
          </label>
          <Button size="sm" disabled={packLoading} onClick={() => void openPack()}>Rebuild</Button>
        </div>
        {packLoading ? <p role="status" className="meta">Building the pack</p> : null}
        {pack ? (
          <div className="pack-preview">
            <p className="meta">{plural(pack.evidence.length, 'excerpt')}, about {pack.tokenEstimate.toLocaleString('en')} tokens, {plural(pack.staleCount, 'stale excerpt')}. Redaction: {pack.redactionStatus}.</p>
            <p className="pack-excerpt">{first?.excerpt ?? 'No evidence matched this session title.'}</p>
            {first ? <p className="meta mono">{first.sessionId.slice(-8)}, turns {first.turnStart} to {first.turnEnd}, {first.ageDays}d old</p> : null}
          </div>
        ) : null}
        {actionError ? <p role="alert" className="error-note">{actionError}</p> : null}
      </div>
      <footer className="modal-actions">
        {pack ? <CopyButton value={pack.markdown} label="Copy pack" /> : null}
        <Button variant="primary" disabled={!pack} onClick={() => { setPackOpen(false); setConvertOpen(true); }}>Send to agent</Button>
      </footer>
    </Modal>
  );
}
