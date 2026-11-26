import type { ConversionJob, Machine } from '../../lib/types';
import { Button, CopyButton, Modal } from '../../components/ui';

const TARGETS: Array<[ConversionJob['target'], string, string]> = [
  ['claude-code', 'Claude Code', 'claude -r'],
  ['codex', 'Codex', 'codex resume'],
  ['antigravity-cli', 'Antigravity', 'agy --conversation'],
];

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
    <Modal open={convertOpen} title="Resume in another agent" description="The session is mapped into the target agent's format. Blocks it cannot carry are listed in the report." onClose={() => setConvertOpen(false)}>
      <div className="modal-body">
        <div className="choice-list" role="radiogroup" aria-label="Target agent">
          {TARGETS.map(([value, label, command]) => (
            <button key={value} type="button" role="radio" aria-checked={target === value} className="choice" onClick={() => setTarget(value)}>
              <span className="radio-dot" aria-hidden="true" />
              <strong>{label}</strong>
              <small className="mono">{command}</small>
            </button>
          ))}
        </div>
        <label className="field-label">Materialize on
          {machines.length === 0 ? (
            <span className="field-empty">No machines connected yet</span>
          ) : (
            <select value={machineId || machines[0]?.id} onChange={(event) => setMachineId(event.target.value)}>
              {machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}, {machine.platform}</option>)}
            </select>
          )}
        </label>
        {conversion ? (
          <div className="conversion-status" role="status">
            <p><strong>Conversion {conversion.status}.</strong> {conversion.resumeCommand ? 'Run this on the machine:' : 'This updates when the bundle is ready.'}</p>
            {conversion.resumeCommand ? <div className="command"><code>{conversion.resumeCommand}</code><CopyButton value={conversion.resumeCommand} label="Copy resume command" /></div> : null}
          </div>
        ) : null}
        {actionError ? <p role="alert" className="error-note">{actionError}</p> : null}
      </div>
      <footer className="modal-actions">
        <Button variant="ghost" onClick={() => setConvertOpen(false)}>Cancel</Button>
        <Button variant="primary" onClick={() => void queueConversion()}>Queue conversion</Button>
      </footer>
    </Modal>
  );
}
