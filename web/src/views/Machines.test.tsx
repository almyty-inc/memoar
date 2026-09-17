import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MachinesView } from './Machines';
import type { Machine } from '../lib/types';

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'm-1',
    name: 'workstation',
    platform: 'darwin',
    status: 'online',
    lastSeenAt: '2026-08-20T00:00:00.000Z',
    agentVersion: '0.3.0',
    sources: [{ id: 'claude-code', label: 'Claude Code', enabled: true, state: 'synced', sessionCount: 3, lastSyncAt: null }],
    ...overrides,
  };
}

describe('machines overview', () => {
  it('offers no install command that does not exist', () => {
    // This page told you to run `npx memoar connect`. That is not one of the
    // CLI's commands, and nothing is published to run it with — so the one
    // instruction the product gave you failed on the first line.
    render(<MachinesView machines={[machine()]} onConnect={vi.fn()} />);

    expect(screen.queryByText(/npx memoar connect/u)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Setup guide/u }).length).toBeGreaterThan(0);
  });

  it('does not flag a source somebody switched off as a fault', () => {
    /*
      The icon was a two-step ternary — synced, syncing, and otherwise the
      warning triangle — so a source the reader had deliberately disabled sat
      under a fault icon beside the word "Disabled". Turning something off is
      not a fault, and the page beside it counts faults ("1 source needs
      attention") from a different field entirely.
    */
    const sources = [
      { id: 'claude-code', label: 'Claude Code', enabled: false, state: 'disabled' as const, sessionCount: 0, lastSyncAt: null },
      { id: 'codex', label: 'Codex', enabled: true, state: 'attention' as const, sessionCount: 1, lastSyncAt: null },
    ];
    const { container } = render(<MachinesView machines={[machine({ sources })]} onConnect={vi.fn()} />);

    const disabled = container.querySelector('.source-state-disabled svg');
    const attention = container.querySelector('.source-state-attention svg');
    expect(disabled?.getAttribute('class')).not.toMatch(/alert/u);
    expect(attention?.getAttribute('class')).toMatch(/alert/u);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('names a connection state in words rather than printing the enum', () => {

    render(<MachinesView machines={[machine({ status: 'never_connected', lastSeenAt: null })]} onConnect={vi.fn()} />);

    expect(screen.getByText('Never connected')).toBeInTheDocument();
    expect(screen.queryByText('never_connected')).not.toBeInTheDocument();
  });

  it('says which machines have not reported instead of reassuring', () => {
    // This tile read "Capture healthy — raw mirror is up to date" whatever the
    // machines were doing, on the page you would open precisely because you
    // suspected something was wrong.
    render(<MachinesView machines={[machine(), machine({ id: 'm-2', name: 'laptop', status: 'offline' })]} onConnect={vi.fn()} />);

    const tile = screen.getByText('1 not reporting').parentElement;
    expect(tile, 'and names the one that has not').toHaveTextContent('laptop');
  });

  it('says so plainly when every machine has checked in', () => {
    render(<MachinesView machines={[machine()]} onConnect={vi.fn()} />);

    expect(screen.getByText('All machines reporting')).toBeInTheDocument();
    expect(screen.queryByText(/Capture healthy/)).not.toBeInTheDocument();
  });

  it('counts sessions and sources from the machines themselves', () => {
    render(<MachinesView machines={[machine(), machine({ id: 'm-2', name: 'laptop' })]} onConnect={vi.fn()} />);

    expect(screen.getByText('6 sessions')).toBeInTheDocument();
    expect(screen.getByText('1 sources')).toBeInTheDocument();
    expect(screen.getByText('2 online')).toBeInTheDocument();
  });
});
