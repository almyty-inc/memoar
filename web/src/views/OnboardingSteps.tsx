import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { memoarApi } from '../lib/api';
import type { Machine } from '../lib/types';
import { Button, CopyButton, PageHeader, StatusDot, cn, formatRelative, plural } from '../components/ui';

/**
 * Getting a machine archiving: two commands, and the machines the archive has
 * heard from. Every number is read from the archive, and the commands are the
 * ones the CLI accepts.
 */
export function OnboardingView({ machines, onComplete, onRefresh }: {
  machines: Machine[];
  onComplete: () => void;
  onRefresh: () => Promise<void>;
}) {
  const endpoint = memoarApi.endpoint || 'https://your-memoar-endpoint/v1';
  const login = `memoar login --endpoint ${endpoint}`;
  const sync = 'memoar sync --watch';

  // Null until the archive answers: the sentence drops the number rather than guess.
  const [connectorCount, setConnectorCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    void memoarApi.getCapabilities()
      .then((capabilities) => { if (active) setConnectorCount(capabilities.connectorCount); })
      .catch(() => { if (active) setConnectorCount(null); });
    return () => { active = false; };
  }, []);

  // What the page waits for happens on another machine, so it asks the archive.
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (machines.length > 0) return;
    const timer = window.setInterval(() => {
      setChecking(true);
      void onRefresh().finally(() => setChecking(false));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [machines.length, onRefresh]);

  // A machine that never checked in is a registration, not a connection.
  const reporting = machines.filter((machine) => machine.status !== 'never_connected');
  const connected = reporting.length > 0;
  const captured = machines.reduce(
    (total, machine) => total + machine.sources.reduce((count, source) => count + source.sessionCount, 0),
    0,
  );
  const steps = [
    { label: 'Signed in to this archive', done: true },
    { label: connected ? `${reporting.length} of ${plural(machines.length, 'registered machine')} checked in` : 'A machine checks in', done: connected },
    { label: captured > 0 ? `${plural(captured, 'session')} captured` : 'The first session is captured', done: captured > 0 },
  ];

  return (
    <div className="page narrow-page">
      <PageHeader title="Connect a machine" />

      <ol className="steps" aria-label="Setup progress">
        {steps.map((step) => (
          <li key={step.label} className={cn(step.done && 'done')}>
            <span className="step-mark" aria-hidden="true">{step.done ? <Check size={11} strokeWidth={3} /> : null}</span>
            <span>{step.label}</span>
            <span className="sr-only">{step.done ? 'done' : 'not yet'}</span>
          </li>
        ))}
      </ol>

      <section className="section">
        <h2 className="section-title">Run these on the machine you code on</h2>
        <div className="command-stack">
          <div className="command install-command"><span className="prompt" aria-hidden="true">$</span><code>{login}</code><CopyButton value={login} label="Copy sign-in command" /></div>
          <div className="command install-command"><span className="prompt" aria-hidden="true">$</span><code>{sync}</code><CopyButton value={sync} label="Copy sync command" /></div>
        </div>
        <dl className="plain-dl">
          <dt>login</dt><dd>Registers the machine. The agent keeps a token that can only capture.</dd>
          {/* The count comes from GET /capabilities, so the sentence and the
              software cannot disagree. Until it answers there is no number. */}
          <dt>sync</dt><dd>Reads {connectorCount === null ? 'the session stores your coding agents already write' : `${connectorCount} agents' session stores`}, plus the instruction files they read. Nothing else.</dd>
          <dt>--watch</dt><dd>Keeps going, and re-reads files as they grow. It queues while offline.</dd>
        </dl>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Machines on this account</h2>
          <span className="meta">{connected ? plural(machines.length, 'machine') : checking ? 'Checking' : 'Waiting, this updates by itself'}</span>
        </div>
        {connected ? (
          <div className="row-list">
            {machines.map((machine) => {
              const sessions = machine.sources.reduce((total, source) => total + source.sessionCount, 0);
              const active = machine.sources.filter((source) => source.enabled);
              return (
                <div className="row" key={machine.id}>
                  <StatusDot status={machine.status} />
                  <strong className="row-name">{machine.name}</strong>
                  <span className="row-main meta">
                    {machine.platform} · agent {machine.agentVersion} · {active.length} of {machine.sources.length} sources on
                    {' · '}{plural(sessions, 'session')}
                    {machine.lastSeenAt ? ` · seen ${formatRelative(machine.lastSeenAt)}` : ' · never seen'}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="empty-note">No machine has signed in yet. Run the two commands above and it appears here.</p>
        )}
        <div className="actions section-foot">
          <Button variant="primary" size="sm" disabled={!connected} onClick={onComplete}>
            Open sessions
          </Button>
          <span className="meta">Captured sessions stay private until you share one, and sharing always starts with a redaction review.</span>
        </div>
      </section>
    </div>
  );
}
