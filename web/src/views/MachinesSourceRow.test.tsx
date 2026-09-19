import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mapMachine } from '../lib/api/mappers';
import { MachinesView } from './Machines';

/**
 * A source row as the archive actually describes one.
 *
 * `GET /machines` returns `{ source, settings, sessionCount }` per source — the
 * settings being what the agent on that machine wrote about its own
 * configuration. It has never sent a sync state or a sync time.
 */
const WIRE_MACHINE = {
  id: 'm-1',
  name: 'workstation',
  platform: 'macOS 15',
  status: 'online' as const,
  lastSeenAt: '2026-09-01T09:00:00.000Z',
  agentVersion: '0.3.0',
  sources: [{ source: 'claude-code', settings: { enabled: true }, sessionCount: 3 }],
};

describe('a source the archive reports', () => {
  it('is not given a sync state the archive never sent', () => {
    /*
      The mapper filled this in as `enabled ? 'synced' : 'disabled'`, so the
      Status column read "Synced" on every row of every machine, for ever — a
      line of one machine's config file presented as a report on how capture
      was going, beside a "Last sync" of "Never" on the same row.
    */
    render(<MachinesView machines={[mapMachine(WIRE_MACHINE)]} onConnect={vi.fn()} />);

    expect(screen.queryByText('Synced')).not.toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
  });

  it('still names a state the archive does send', () => {
    const attention = { ...WIRE_MACHINE, sources: [{ ...WIRE_MACHINE.sources[0]!, state: 'attention' as const }] };

    const { container } = render(<MachinesView machines={[mapMachine(attention)]} onConnect={vi.fn()} />);

    expect(container.querySelector('.source-state-attention')).toHaveTextContent('Needs attention');
  });

  it('reports whether capture is on rather than offering a switch that changes nothing', async () => {
    /*
      This was a switch bound to component state and to nothing else. Pressing
      it moved the thumb, sent no request, and was undone the next time the
      page was drawn — so somebody who switched a source off had every reason
      to believe capture had stopped, and it had not. Which stores the agent
      reads is that machine's own configuration.
    */
    const user = userEvent.setup();
    render(<MachinesView machines={[mapMachine(WIRE_MACHINE)]} onConnect={vi.fn()} />);

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByText('Capture on')).toBeInTheDocument();

    // Nothing on this row invites a press that would do nothing.
    const row = screen.getByText('Capture on').closest('.source-row');
    expect(row?.querySelectorAll('button')).toHaveLength(0);
    await user.click(screen.getByText('Capture on'));
    expect(screen.getByText('Capture on')).toBeInTheDocument();
  });
});
