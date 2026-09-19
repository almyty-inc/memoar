import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingView } from './OnboardingSteps';
import type { Machine } from '../lib/types';
import { memoarApi } from '../lib/api';

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'm-1',
    name: 'workstation',
    platform: 'darwin',
    status: 'online',
    lastSeenAt: null,
    agentVersion: '0.3.0',
    sources: [
      { id: 'claude-code', label: 'Claude Code', enabled: true, state: 'synced', sessionCount: 12, lastSyncAt: null },
      { id: 'codex', label: 'Codex', enabled: false, state: 'disabled', sessionCount: 0, lastSyncAt: null },
    ],
    ...overrides,
  };
}

describe('connecting a machine', () => {
  it('gives commands the agent actually has', () => {
    // This page offered `npx memoar connect`, which is not one of the CLI's
    // commands: login, status, sources, sync, search, view, pack, convert,
    // listen, doctor, capabilities, introspect. Anyone following it ran
    // something that fails.
    render(<OnboardingView machines={[]} onComplete={vi.fn()} onRefresh={() => Promise.resolve()} />);

    expect(screen.getByText(/^memoar login --endpoint/)).toBeInTheDocument();
    expect(screen.getByText('memoar sync --watch')).toBeInTheDocument();
    expect(screen.queryByText(/npx memoar connect/)).not.toBeInTheDocument();
  });

  it('reports the machines on the account, not an invented one', () => {
    // It used to show "Atlas · MacBook Pro" with "284 found" for Claude Code
    // and a progress bar reading "312 of 542 sessions" — none of it counted,
    // none of it belonging to anybody's account.
    render(<OnboardingView machines={[machine()]} onComplete={vi.fn()} onRefresh={() => Promise.resolve()} />);

    expect(screen.getByText('workstation')).toBeInTheDocument();
    expect(screen.getByText(/darwin · agent 0\.3\.0 · 1 of 2 sources on · 12 sessions/)).toBeInTheDocument();
    expect(screen.queryByText(/Atlas/)).not.toBeInTheDocument();
    expect(screen.queryByText(/284|312|542/)).not.toBeInTheDocument();
  });

  it('does not count connectors it cannot see', () => {
    /*
      This said "Eleven agents' session stores" — an English literal in a React
      file bound to a Rust array in another crate. It was accurate the day it
      was written, and nothing keeps it so: adding a connector is a change in
      agent/crates/memoar-connectors with no reason to visit this file, and the
      archive reports no count for the page to read instead.
    */
    render(<OnboardingView machines={[]} onComplete={vi.fn()} onRefresh={() => Promise.resolve()} />);

    const explainer = screen.getByText(/session stores/u);
    expect(explainer).toHaveTextContent(/session stores/u);
    // No number before the archive has answered, and never a written-out one.
    expect(explainer.textContent).not.toMatch(/Eleven|eleven|\b\d+\b/u);

  });

  it('waits honestly when no machine has signed in', () => {

    render(<OnboardingView machines={[]} onComplete={vi.fn()} onRefresh={() => Promise.resolve()} />);

    expect(screen.getByText(/No machine has signed in yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open the timeline/ })).toBeDisabled();
  });

  it('asks the archive again while it waits, so the reader does not have to reload', () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    try {
      render(<OnboardingView machines={[]} onComplete={vi.fn()} onRefresh={refresh} />);
      expect(refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(11_000);
      expect(refresh).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking once a machine is there', () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    try {
      render(<OnboardingView machines={[machine()]} onComplete={vi.fn()} onRefresh={refresh} />);
      vi.advanceTimersByTime(30_000);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the connector count', () => {
  it('states the number the archive reports', async () => {
    vi.spyOn(memoarApi, 'getCapabilities').mockResolvedValue({
      contractVersion: '0.3.0',
      connectors: ['claude-code', 'codex', 'cursor'],
      connectorCount: 3,
      uploadFormats: ['chatgpt-export'],
    });
    render(<OnboardingView machines={[machine()]} onComplete={vi.fn()} onRefresh={vi.fn()} />);
    expect(await screen.findByText(/3 agents' session stores/u)).toBeInTheDocument();
  });

  it('carries no number when the archive cannot be asked', async () => {
    vi.spyOn(memoarApi, 'getCapabilities').mockRejectedValue(new Error('offline'));
    render(<OnboardingView machines={[machine()]} onComplete={vi.fn()} onRefresh={vi.fn()} />);
    const explainer = await screen.findByText(/session stores/u);
    expect(explainer.textContent).not.toMatch(/\b\d+\b/u);
  });
});
