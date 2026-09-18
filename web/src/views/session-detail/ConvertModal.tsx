import { ArrowRight, Check, Code2, Sparkles } from 'lucide-react';
import type { ConversionJob, Machine } from '../../lib/types';
import { Button, Modal, cn } from '../../components/ui';

export function ConvertModal({ convertOpen, setConvertOpen, target, setTarget, machines, machineId, setMachineId, conversion, actionError, queueConversion }: {
  convertOpen: boolean;
  setConvertOpen: (open: boolean) => void;
  target: ConversionJob['target'];
  setTarget: (target: ConversionJob['target']) => void;
  machines: Machine[];
  machineId: string;
  setMachineId: (machineId: string) => void;
  conversion: ConversionJob | null;
  actionError: string | null;
  queueConversion: () => Promise<void>;
}) {
  return (
    <Modal
      open={convertOpen}
      title="Resume in another agent"
      description="Memoar maps the canonical session into the target agent and reports any degraded blocks."
      onClose={() => setConvertOpen(false)}
    >
      <div className="modal-body">
        <div className="target-grid" role="radiogroup" aria-label="Target agent">
          {([
            ['claude-code', 'Claude Code', 'claude -r'],
            ['codex', 'Codex', 'codex resume'],
            ['antigravity-cli', 'Antigravity', 'agy --conversation'],
          ] as const).map(([value, label, command]) => (
            <button key={value} type="button" role="radio" aria-checked={target === value} className={cn('target-option', target === value && 'active')} onClick={() => setTarget(value)}>
              <span><Code2 size={17} /></span><strong>{label}</strong><small>{command}</small>{target === value ? <Check size={15} /> : null}
            </button>
          ))}
        </div>
        <label className="field-label">Materialize on
          {machines.length === 0 ? (
            <span className="field-empty">No machines connected yet</span>
          ) : (
            <select value={machineId || machines[0]?.id} onChange={(event) => setMachineId(event.target.value)}>
              {machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name} · {machine.platform}</option>)}
            </select>
          )}
        </label>
        <div className="conversion-note"><Sparkles size={16} /><p><strong>{conversion ? `Conversion ${conversion.status}` : 'Conversion report'}</strong><br />{conversion?.resumeCommand ?? (conversion ? 'Converting in the background — this stays open until the bundle is ready.' : 'Queue the canonical session to receive an exact resume command and mapping report.')}</p></div>
        {actionError ? <p role="alert" className="error-note">{actionError}</p> : null}
      </div>
      <footer className="modal-actions"><Button variant="ghost" onClick={() => setConvertOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => void queueConversion()}>Queue conversion <ArrowRight size={14} /></Button></footer>
    </Modal>
  );
}
