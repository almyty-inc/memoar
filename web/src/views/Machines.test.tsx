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
