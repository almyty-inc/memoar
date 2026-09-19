import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Transfer } from '../lib/types';
import { SharingView } from './Sharing';

function transfer(id: string, status: Transfer['status']): Transfer {
  return {
    id,
    sessionId: 's-1',
    sessionTitle: 'Fix the ingest pipeline',
    senderEmail: 'bob@example.test',
    recipientEmail: 'ada@example.test',
    status,
    direction: 'incoming',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

function view(transfers: Transfer[]) {
  return (
    <SharingView
      grants={[]}
      transfers={transfers}
      sessions={[]}
      asOf={Date.parse('2026-09-02T00:00:00.000Z')}
      onAcceptTransfer={vi.fn()}
      onDeclineTransfer={vi.fn()}
      onRevokeGrant={vi.fn()}
      onRequestTransfer={vi.fn()}
    />
  );
}

describe('the sharing tabs', () => {
  it('count what their panel holds, the same way as each other', () => {
    /*
      The links tab counted every grant and the transfers tab counted only the
      pending ones, so a reader with three settled transfers and none pending
      saw "Transfers 0" over a panel listing all three. How many are pending is
      said once, below, where it is labelled.
    */
    render(view([transfer('t-1', 'accepted'), transfer('t-2', 'declined'), transfer('t-3', 'pending')]));

    const transfersTab = screen.getByRole('tab', { name: /Transfers/u });
    expect(within(transfersTab).getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/pending transfer/u)).toHaveTextContent('1 pending transfer');
  });

  it('shows an incoming transfer the accept and decline it needs', async () => {
    const user = userEvent.setup();
    render(view([transfer('t-1', 'pending')]));
    await user.click(screen.getByRole('tab', { name: /Transfers/u }));

    // Reachable at all only because the direction is worked out from the
    // signed-in account rather than from a development fixture's domain.
    expect(screen.getByRole('button', { name: /Accept/u })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Decline/u })).toBeInTheDocument();
  });
});
