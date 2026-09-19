import { ArrowRight, ShieldCheck } from 'lucide-react';
import type { PackResponse } from '../../lib/types';
import { Badge, Button, CopyButton, Modal } from '../../components/ui';

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
  return (
    <Modal
      open={packOpen}
      title="Pack preview"
      description="A cited, extractive bundle that fits the chosen context budget."
      onClose={() => setPackOpen(false)}
    >
      <div className="modal-body pack-modal-body">
        <div className="budget-row">
          <label>Token budget<input type="number" value={packBudget} min={64} max={32000} onChange={(event) => setPackBudget(Number(event.target.value))} /></label>
          <label>Freshness
            <select value={packFreshness} onChange={(event) => setPackFreshness(event.target.value === 'strict' ? 'strict' : 'mixed')}>
              <option value="mixed">Mixed, flag stale</option>
              <option value="strict">Strict, fresh only</option>
            </select>
          </label>
          <Button size="sm" variant="ghost" disabled={packLoading} onClick={() => void openPack()}>Rebuild</Button>
        </div>
        {packLoading ? <p role="status">Building cited preview…</p> : null}
        {pack ? (
          <div className="pack-preview-card">
            <div><Badge>{pack.evidence.length} excerpts</Badge><span>Estimated {pack.tokenEstimate.toLocaleString()} tokens</span></div>
            <h3>{pack.query}</h3>
            <p>{pack.evidence[0]?.excerpt ?? 'No evidence matched this session title.'}</p>
            {pack.evidence[0] ? <small>[{pack.evidence[0].sessionId.slice(-8)} · turns {pack.evidence[0].turnStart}–{pack.evidence[0].turnEnd} · {pack.evidence[0].ageDays}d]</small> : null}
          </div>
        ) : null}
        {actionError ? <p role="alert" className="error-note">{actionError}</p> : null}
        {pack ? <div className="redaction-safe"><ShieldCheck size={15} /><span>Redaction status: {pack.redactionStatus}. {pack.staleCount} stale excerpts.</span></div> : null}
      </div>
      <footer className="modal-actions">{pack ? <CopyButton value={pack.markdown} label="Copy pack" /> : null}<Button variant="primary" disabled={!pack} onClick={() => { setPackOpen(false); setConvertOpen(true); }}>Send to agent <ArrowRight size={14} /></Button></footer>
    </Modal>
  );
}
