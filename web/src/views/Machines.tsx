import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { memoarApi } from '../lib/api';
import type { Machine, UnparsedSource } from '../lib/types';
import { Button, PageHeader, StatusDot, cn, formatRelative, plural } from '../components/ui';
import { machineStatusLabel } from '../lib/source-labels';
import { SourceRow } from './machines/SourceRow';
import { UnparsedPanel } from './machines/UnparsedPanel';

export function MachinesView({ machines, onConnect }: { machines: Machine[]; onConnect: () => void }) {
  // Collapsed rather than expanded is what is remembered, so machines that
  // arrive after the first render open like the rest.
  const [collapsed, setCollapsed] = useState<string[]>([]);
  /*
    What capture collected and the archive could not read. Null until the
    archive answers and null if it refuses: a count this page could not get is
    not a zero.
  */
  const [unparsed, setUnparsed] = useState<UnparsedSource[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void memoarApi.listUnparsedArtifacts()
      .then((items) => { if (!cancelled) setUnparsed(items); })
      .catch(() => { if (!cancelled) setUnparsed(null); });
    return () => { cancelled = true; };
  }, []);
  const unparsedBySource = new Map((unparsed ?? []).map((item) => [item.source, item]));
  const toggle = (id: string) => setCollapsed((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const sessionCount = machines.flatMap((machine) => machine.sources).reduce((count, source) => count + source.sessionCount, 0);
  const sourceCount = new Set(machines.flatMap((machine) => machine.sources.map((source) => source.id))).size;
  const online = machines.filter((machine) => machine.status === 'online').length;
  const needsAttention = machines.flatMap((machine) => machine.sources.filter((source) => source.state === 'attention').map((source) => ({ machine, source })));
  // The server decides this from when each machine last checked in.
  const silent = machines.filter((machine) => machine.status !== 'online');

  return (
    <div className="page machines-page">
      <PageHeader title="Machines" count={plural(machines.length, 'machine')}>
        <Button size="sm" variant="primary" onClick={onConnect}>Connect a machine</Button>
      </PageHeader>

      {machines.length > 0 ? (
        <p className="summary-line">
          <span>{online} online</span>
          <span>{plural(sourceCount, 'source')}</span>
          <span>{plural(sessionCount, 'session')}</span>
          <span className={cn(silent.length > 0 && 'text-warning')}>
            {silent.length === 0 ? 'All machines reporting' : `${silent.length} not reporting: ${silent.slice(0, 3).map((machine) => machine.name).join(', ')}${silent.length > 3 ? ` and ${silent.length - 3} more` : ''}`}
          </span>
        </p>
      ) : (
        <p className="empty-note">No machines yet. Run <code>memoar login</code> on the machine you code on. The <button type="button" className="link-button" onClick={onConnect}>Setup guide</button> has both commands.</p>
      )}

      {/* Only the sources actually in that state, and nothing when none are. */}
      {needsAttention.length > 0 ? (
        <div className="notice notice-warning">
          <p><strong>{needsAttention.length === 1 ? '1 source needs attention.' : `${needsAttention.length} sources need attention.`}</strong> {needsAttention.map(({ machine, source }) => `${source.label} on ${machine.name}`).join(', ')}. The raw files are kept for parser diagnostics.</p>
        </div>
      ) : null}

      {unparsed ? <UnparsedPanel items={unparsed} machines={machines} /> : null}

      <div className="machine-list">
        {machines.map((machine) => {
          const isExpanded = !collapsed.includes(machine.id);
          return (
            <section className="machine" key={machine.id} aria-label={machine.name}>
              <div className="machine-head">
                <button
                  type="button"
                  className="machine-toggle"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${machine.name}`}
                  onClick={() => toggle(machine.id)}
                >
                  <ChevronRight size={13} aria-hidden="true" className={cn('chevron', isExpanded && 'open')} />
                </button>
                <StatusDot status={machine.status} />
                <h2>{machine.name}</h2>
                <span className="meta">{machineStatusLabel(machine.status)}</span>
                <span className="meta">{machine.platform} · agent {machine.agentVersion}</span>
                <span className="meta machine-seen">{machine.lastSeenAt ? `Seen ${formatRelative(machine.lastSeenAt)}` : 'Never seen'}</span>
              </div>
              {isExpanded ? (
                <div className="source-table">
                  {machine.sources.length > 0 ? (
                    <div className="source-row source-head" aria-hidden="true"><span>Source</span><span>Sessions</span><span>Last sync</span><span>Status</span><span>Capture</span></div>
                  ) : <p className="empty-note">No sources reported yet.</p>}
                  {machine.sources.map((source) => <SourceRow key={source.id} source={source} unparsed={unparsedBySource.get(source.id)} />)}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      {machines.length > 0 ? (
        <p className="meta section-foot">Another computer: run <code>memoar login</code> there, or open the <button type="button" className="link-button" onClick={onConnect}>Setup guide</button>.</p>
      ) : null}
    </div>
  );
}
