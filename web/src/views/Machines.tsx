import {
  AlertCircle,
  Check,
  ChevronDown,
  CircleDot,
  Cloud,
  Code2,
  Cpu,
  HardDrive,
  Laptop,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useState } from 'react';
import type { Machine, MachineSource } from '../lib/types';
import { Badge, Button, CopyButton, IconButton, StatusDot, cn, formatRelative } from '../components/ui';

const stateCopy: Record<MachineSource['state'], string> = {
  synced: 'Synced',
  syncing: 'Syncing now',
  attention: 'Needs attention',
  disabled: 'Disabled',
};

export function MachinesView({ machines, onConnect }: { machines: Machine[]; onConnect: () => void }) {
  const [expanded, setExpanded] = useState<string[]>(machines.slice(0, 2).map((machine) => machine.id));
  const toggle = (id: string) => setExpanded((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const sessionCount = machines.flatMap((machine) => machine.sources).reduce((count, source) => count + source.sessionCount, 0);
  const needsAttention = machines.flatMap((machine) => machine.sources.filter((source) => source.state === 'attention').map((source) => ({ machine, source })));

  return (
    <div className="page machines-page">
      <section className="page-heading row-heading">
        <div><div className="eyebrow"><Cpu size={13} /> Capture network</div><h1>Machines & sources</h1><p>Monitor the local agents that discover, preserve, and sync native session files.</p></div>
        <Button variant="primary" onClick={onConnect}><Plus size={16} /> Connect machine</Button>
      </section>

      <section className="machine-overview">
        <div><span className="overview-icon online"><Wifi size={18} /></span><div><strong>{machines.filter((machine) => machine.status === 'online').length} online</strong><p>of {machines.length} registered machines</p></div></div>
        <div><span className="overview-icon"><Code2 size={18} /></span><div><strong>{new Set(machines.flatMap((machine) => machine.sources.map((source) => source.id))).size} sources</strong><p>across every machine</p></div></div>
        <div><span className="overview-icon"><Cloud size={18} /></span><div><strong>{sessionCount} sessions</strong><p>preserved in cloud archive</p></div></div>
        <div><span className="overview-icon secure"><ShieldCheck size={18} /></span><div><strong>Capture healthy</strong><p>Raw mirror is up to date</p></div></div>
      </section>

      <div className="machine-list">
        {machines.map((machine) => {
          const isExpanded = expanded.includes(machine.id);
          return (
            <article className="machine-card" key={machine.id}>
              <header>
                <span className="machine-icon">{machine.platform.includes('macOS') ? <Laptop size={20} /> : <Server size={20} />}</span>
                <div className="machine-heading"><div><h2>{machine.name}</h2><StatusDot status={machine.status} /><Badge>{machine.status}</Badge></div><p>{machine.platform} · agent {machine.agentVersion}</p></div>
                <div className="machine-last-seen"><span>{machine.status === 'online' ? <Wifi size={14} /> : <WifiOff size={14} />}{formatRelative(machine.lastSeenAt)}</span><small>{machine.sources.length} discovered sources</small></div>
                <IconButton className={cn('expand-button', isExpanded && 'expanded')} label={`${isExpanded ? 'Collapse' : 'Expand'} ${machine.name}`} onClick={() => toggle(machine.id)}><ChevronDown size={17} /></IconButton>
              </header>
              {isExpanded ? (
                <div className="source-list">
                  <div className="source-list-head"><span>Source</span><span>Archive</span><span>Last sync</span><span>Status</span><span /></div>
                  {machine.sources.map((source) => <SourceRow key={source.id} source={source} />)}
                  <button className="add-source-row" type="button" onClick={onConnect}><Plus size={14} /> Discover another source on {machine.name}</button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {/*
        This described "Cursor source needs attention on Atlas · Format drift"
        as a literal, on every archive, whether or not any source needed
        attention and whether or not a machine named Atlas existed. It now
        reports the sources actually in that state, and renders nothing when
        none are.
      */}
      {needsAttention.length > 0 ? (
        <section className="source-diagnostic">
          <div>
            <span><HardDrive size={18} /></span>
            <div>
              <strong>{needsAttention.length} {needsAttention.length === 1 ? 'source needs' : 'sources need'} attention</strong>
              <p>{needsAttention.map(({ machine, source }) => `${source.label} on ${machine.name}`).join(', ')}. The raw files are preserved and queued for parser diagnostics.</p>
            </div>
          </div>
          <Badge className="redaction-findings"><AlertCircle size={12} /> Needs attention</Badge>
        </section>
      ) : null}

      <section className="install-inline">
        <span><CircleDot size={18} /></span><div><strong>Connect another computer</strong><p>The install command registers a machine-specific token and starts source discovery.</p></div><code>npx memoar connect</code><CopyButton value="npx memoar connect" label="Copy" /><Button size="sm" variant="ghost" onClick={onConnect}>Setup guide</Button>
      </section>
    </div>
  );
}

function SourceRow({ source }: { source: MachineSource }) {
  const [enabled, setEnabled] = useState(source.enabled);
  return (
    <div className="source-row">
      <div><span className={`mini-source source-${source.id.replace('-cli', '').replace('-code', '')}`}><Code2 size={15} /></span><div><strong>{source.label}</strong><small>Native local store</small></div></div>
      <span><strong>{source.sessionCount}</strong> sessions</span>
      <span>{formatRelative(source.lastSyncAt)}</span>
      <span className={cn('source-state', `source-state-${source.state}`)}>{source.state === 'synced' ? <Check size={13} /> : source.state === 'syncing' ? <RefreshCw size={13} /> : <AlertCircle size={13} />}{stateCopy[source.state]}</span>
      <button className={cn('switch compact', enabled && 'switch-on')} type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? 'Disable' : 'Enable'} ${source.label}`} onClick={() => setEnabled(!enabled)}><span /></button>
    </div>
  );
}
