import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ImportView } from './Import';
import type { Machine, SessionSummary } from '../lib/types';

function machine(): Machine {
  return {
    id: 'm-1', name: 'workstation', platform: 'darwin', status: 'online',
    lastSeenAt: null, agentVersion: '0.3.0',
    sources: [{ id: 'claude-code', label: 'Claude Code', enabled: true, state: 'synced', sessionCount: 3, lastSyncAt: null }],
  };
}

describe('importing an archive', () => {
  it('does not open by telling the reader they have done something wrong', () => {
    /*
      With no machine registered this rendered "Register a machine before
      submitting an ingest manifest." as a role="alert" in --danger, on
      arrival, before the reader had touched anything. Nothing has failed: the
      submit is disabled until a machine is chosen, so nothing can have.
    */
    const { container } = render(<ImportView machines={[]} onImport={vi.fn()} onOpen={vi.fn()} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const hint = container.querySelector('.field-hint');
    expect(hint).toHaveTextContent(/Register a machine/u);
    expect(screen.getByRole('button', { name: /Import archive/u })).toBeDisabled();
  });

  it('gives a failure the failure surface, not the notice surface', async () => {
    // "Import failed" wore className="privacy-banner" — the identical chrome
    // to the neutral privacy notice beside it.
    const onImport = vi.fn().mockRejectedValue(new Error('artifact rejected: unknown_format'));
    const { container } = render(<ImportView machines={[machine()]} onImport={onImport} onOpen={vi.fn()} />);

    await userEvent.upload(
      screen.getByLabelText('Archive file'),
      new File(['{}'], 'export.json', { type: 'application/json' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Import archive/u }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('artifact rejected: unknown_format');
    expect(banner).toHaveClass('banner-error');
    expect(container.querySelector('.privacy-banner:not(.banner-error)')).toBeNull();
  });

  it('keeps the neutral surface for progress, which is not a failure', async () => {
    const imported: SessionSummary = {
      id: 's-1', title: 'Imported', summary: '', source: 'claude-code', sourceLabel: 'Claude Code',
      workspace: '/w', createdAt:
 '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
      turnCount: 1, tokenCount: 0, durationMinutes: 0, redactionStatus: 'clear',
    };
    const onImport = vi.fn((_f, _s, _m, onProgress: (p: { stage: 'ready'; detail: string }) => void) => {
      onProgress({ stage: 'ready', detail: 'parsed' });
      return Promise.resolve(imported);
    });

    const { container } = render(<ImportView machines={[machine()]} onImport={onImport as never} onOpen={vi.fn()} />);

    await userEvent.upload(
      screen.getByLabelText('Archive file'),
      new File(['{}'], 'export.json', { type: 'application/json' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Import archive/u }));

    const progress = await screen.findByRole('status');
    expect(progress).toHaveClass('privacy-banner');
    expect(container.querySelector('[role="status"].banner-error')).toBeNull();
  });
});
