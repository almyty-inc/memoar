import { Check, CircleDashed, Cpu, LockKeyhole, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { memoarApi } from '../lib/api';
import type { Machine } from '../lib/types';
import { Badge, Button, CopyButton, StatusDot, cn, formatRelative } from '../components/ui';

/**
 * What it takes to get a machine archiving. Every number is read from the
 * archive, and the commands are the ones the CLI accepts.
 */
export function OnboardingView({ machines, onComplete, onRefresh }: {
  machines: Machine[];
  onComplete: () => void;
  onRefresh: () => Promise<void>;
}) {
  const endpoint = memoarApi.endpoint || 'https://your-memoar-endpoint/v1';
  const login = `memoar login --endpoint ${endpoint}`;
  const sync = 'memoar sync --watch';

  // Null until the archive answers, and null if it refuses: the sentence drops
  // the number rather than guessing one.
  const [connectorCount, setConnectorCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    void memoarApi.getCapabilities()
      .then((capabilities) => { if (active) setConnectorCount(capabilities.connectorCount); })
      .catch(() => { if (active) setConnectorCount(null); });
    return () => { active = false; };
  }, []);

  // The page is waiting for something that happens on another machine, so it
  // asks the archive rather than asking the reader to reload.
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (machines.length > 0) return;
    const timer = window.setInterval(() => {
      setChecking(true);
      void onRefresh().finally(() => setChecking(false));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [machines.length, onRefresh]);

  /*
    A machine that has never checked in is a registration, not a connection.
    Counting rows in the table let a dead registration tick "Agent signed in on
    a machine" and report itself as connected.
  */
  const reporting = machines.filter((machine) => machine.status !== 'never_connected');
  const connected = reporting.length > 0;
  const captured = machines.reduce(
    (total, machine) => total + machine.sources.reduce((count, source) => count + source.sessionCount, 0),
    0,
  );
  const steps = [
    { label: 'Account ready', hint: 'You are signed in to this archive.', done: true },
    {
      label: 'Agent signed in on a machine',
      hint: connected ? `${reporting.length} of ${machines.length} registered ${machines.length === 1 ? 'machine has' : 'machines have'} checked in` : 'Waiting for the first one',
      done: connected,
    },
    {
      // Past tense, because it is a count of what was captured. "Sessions are
      // arriving" was present tense over an archive whose last capture could
      // have been a week ago.
      label: 'First sync',
      hint: captured > 0 ? `${captured} ${captured === 1 ? 'session' : 'sessions'} captured` : 'Nothing captured yet',
      done: captured > 0,
    },
  ];

  return (
    <div className="onboarding-page">
      <header className="onboarding-head">
        <div className="eyebrow"><Terminal size={13} /> Capture</div>
        <h1>Connect a machine.</h1>
        <p>
          Memoar archives what your coding agents already write to disk. The capture agent runs on
          the machine you work on, finds those session files, and uploads them; the archive parses
          them into one searchable history you can resume from any other agent.
        </p>
      </header>

      <div className="onboarding-layout">
        <ol className="setup-steps" aria-label="Setup progress">
          {steps.map((step) => (
            <li key={step.label} className={cn(step.done && 'done')}>
              <span>{step.done ? <Check size={15} /> : <CircleDashed size={15} />}</span>
              <div><strong>{step.label}</strong><p>{step.hint}</p></div>
            </li>
          ))}
        </ol>

        <section className="install-card">
          <header>
            <span><Terminal size={20} /></span>
            <div><h2>Run these on the machine you want to archive</h2><p>The agent keeps a local queue, so it survives being offline.</p></div>
          </header>
          <div className="install-command"><span>$</span><code>{login}</code><CopyButton value={login} label="Copy sign-in command" /></div>
          <div className="install-command"><span>$</span><code>{sync}</code><CopyButton value={sync} label="Copy sync command" /></div>
          <div className="install-explainer">
            <div><p><strong>Signing in registers the machine</strong><small>The archive learns its name and platform; the agent keeps a token scoped to capture.</small></p></div>
            {/*
              The number comes from the archive now. It was the English word
              "Eleven", kept in step with a Rust array in another crate by
              nothing at all — right on the day it was written, and a lie the
              day a twelfth connector shipped. GET /capabilities counts the
              parsers that read a store on a machine, so the sentence and the
              software cannot disagree. Until it answers, the sentence simply
              carries no number.
            */}
            <div><p><strong>Sync discovers what is there</strong><small>{connectorCount === null ? 'The session stores your coding agents already write' : `${connectorCount} agents' session stores`}, plus the instruction files they read. Nothing else is read.</small></p></div>

            <div><p><strong>--watch keeps it going</strong><small>Files are re-read as they grow, so an ongoing session stays up to date.</small></p></div>
          </div>
        </section>

        <section className={cn('sync-card', connected && 'sync-active')}>
          <header>
            <div><h2>Machines on this account</h2><p>{connected ? 'Read from the archive.' : 'This updates by itself when an agent signs in.'}</p></div>
            {connected ? <Badge className="status-active"><span /> {machines.length}</Badge> : <Badge>{checking ? 'Checking' : 'Waiting'}</Badge>}
          </header>

          {connected ? machines.map((machine) => {
            const captured = machine.sources.reduce((total, source) => total + source.sessionCount, 0);
            const active = machine.sources.filter((source) => source.enabled);
            return (
              <div className="discovery-machine" key={machine.id}>
                <span><Cpu size={19} /></span>
                <div>
                  <strong>{machine.name}</strong>
                  <p>
                    {machine.platform} · agent {machine.agentVersion} · {active.length} of {machine.sources.length} sources on
                    {' · '}{captured} {captured === 1 ? 'session' : 'sessions'}
                    {machine.lastSeenAt ? ` · seen ${formatRelative(machine.lastSeenAt)}` : ' · never seen'}
                  </p>
                </div>
                <StatusDot status={machine.status} />
              </div>
            );
          }) : (
            <p className="muted-small">
              No machine has signed in yet. Run the two commands above and this list fills in.
            </p>
          )}

          <Button disabled={!connected} variant="primary" onClick={onComplete}>
            {captured > 0 ? 'Browse the archive' : 'Open the timeline'}
          </Button>
        </section>
      </div>

      <footer className="onboarding-security">
        <LockKeyhole size={15} />
        <span>Captured sessions are private to your account. Sharing one always goes through a redaction review first.</span>
      </footer>
    </div>
  );
}
