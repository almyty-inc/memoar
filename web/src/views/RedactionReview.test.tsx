import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDetailView } from './SessionDetail';
import { memoarApi } from '../lib/api';
import type { Annotation, SessionDetailData } from '../lib/types';

const SESSION_ID = '0191cafe-0000-7000-8000-00000000f001';

function detail(): SessionDetailData {
  return {
    session: {
      id: SESSION_ID,
      title: 'Fix the ingest pipeline',
      source: 'claude-code',
      sourceLabel: 'Claude Code',
      workspace: '/workspace/memoar',
      branch: 'main',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
      turnCount: 2,
      tokenCount: 0,
      redactionStatus: 'findings',
      machineName: 'workstation',
      durationMinutes: 0,
      toolCallCount: 0,
      pinned: false,
      visibility: 'private',
      tags: [],
      models: [],
    },
    turns: [],
    provenance: [],
    tokenTotals: { input: 0, output: 0, cacheRead: 0 },
  } as unknown as SessionDetailData;
}

function mask(id: string, kind: string, preview: string): Annotation {
  return {
    id,
    sessionId: SESSION_ID,
    kind: 'redaction_mask',
    value: { kind, preview, start: 10, end: 42 },
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

/**
 * A machine the session could have come from.
 *
 * Not an empty list: the machine lookup was written above the binding it reads,
 * and an empty list never runs the comparison, so the page rendered in tests
 * and went blank in the browser the moment an account had a machine.
 */
const MACHINES = [{
  id: '0191cafe-0000-7000-8000-00000000ma01',
  name: 'workstation',
  platform: 'darwin',
  status: 'online' as const,
  lastSeenAt: null,
  agentVersion: '0.3.0',
  sources: [],
}];

function renderDetail() {
  return render(
    <SessionDetailView
      detail={detail()}
      collections={[]}
      machines={MACHINES}
      onBack={vi.fn()}
      onBuildPack={vi.fn()}
      onConvert={vi.fn()}
      onConversionStatus={vi.fn()}
      onDeleted={vi.fn()}
      onArchiveChanged={vi.fn()}
    />,
  );
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('redaction review before sharing', () => {
  it('lists what the scanner actually found in this session', async () => {
    // This panel used to announce "2 findings in 1 session" and name a
    // workspace path and a commit author email — the same two every time, for
    // every session, invented. It decides whether a session may leave the
    // archive, so approving a mask over imaginary findings is worse than
    // having no review at all.
    const list = vi.spyOn(memoarApi, 'listAnnotations').mockResolvedValue({
      items: [
        mask('a-1', 'aws_access_key', 'AKIA…7Q2M'),
        mask('a-2', 'private_key', '----…----'),
        { ...mask('a-3', 'note', ''), kind: 'note' },
      ],
    });

    renderDetail();
    await userEvent.click(screen.getByRole('button', { name: /Share/ }));

    expect(await screen.findByText('2 findings in this session')).toBeInTheDocument();
    expect(screen.getByText('Aws access key')).toBeInTheDocument();
    expect(screen.getByText('AKIA…7Q2M')).toBeInTheDocument();
    expect(screen.getByText('Private key')).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith(SESSION_ID);
    // Notes are not findings.
    expect(screen.queryByText('Note')).not.toBeInTheDocument();
  });

  it('says plainly when the scan flagged nothing', async () => {
    vi.spyOn(memoarApi, 'listAnnotations').mockResolvedValue({ items: [] });

    renderDetail();
    await userEvent.click(screen.getByRole('button', { name: /Share/ }));

    expect(await screen.findByText('0 findings in this session')).toBeInTheDocument();
    expect(screen.getByText(/flagged nothing/)).toBeInTheDocument();
  });

  it('reports a failure to read the findings rather than showing none', async () => {
    // Silently showing an empty list would read as "nothing to redact" and
    // walk somebody straight into sharing an unscanned session.
    vi.spyOn(memoarApi, 'listAnnotations').mockRejectedValue(new Error('Archive unreachable'));

    renderDetail();
    await userEvent.click(screen.getByRole('button', { name: /Share/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Archive unreachable');
  });
});
