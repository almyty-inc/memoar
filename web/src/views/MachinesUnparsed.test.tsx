import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MachinesView } from './Machines';
import { memoarApi } from '../lib/api';
import type { Machine, MachineSource, UnparsedSource } from '../lib/types';

function source(overrides: Partial<MachineSource> = {}): MachineSource {
  return { id: 'claude-code', label: 'Claude Code', enabled: true, state: 'synced', sessionCount: 3, lastSyncAt: null, ...overrides };
}

function machine(sources: MachineSource[]): Machine {
  return {
    id: 'm-1',
    name: 'workstation',
    platform: 'darwin',
    status: 'online',
    lastSeenAt: '2026-08-20T00:00:00.000Z',
    agentVersion: '0.3.0',
    sources,
  };
}

function unparsed(items: UnparsedSource[]) {
  return vi.spyOn(memoarApi, 'listUnparsedArtifacts').mockResolvedValue(items);
}

beforeEach(() => { vi.restoreAllMocks(); });

/*
  Files the capture agent uploaded that the archive could not turn into a
  session. `memoar doctor` has reported them for a while and this page did not,
  which is how a capture pattern aimed at the wrong directory ran for weeks —
  twice — with every machine reporting in and syncing on schedule.
*/
describe('unreadable artifacts on the machines page', () => {
  it('says beside a source that it is reading the wrong files', async () => {
    unparsed([{ source: 'codex', artifacts: 412, diagnostic: 'No recognised session file in the collected batch' }]);

    render(<MachinesView machines={[machine([source({ id: 'codex', label: 'Codex CLI', sessionCount: 0 })])]} onConnect={vi.fn()} />);

    const row = (await screen.findByText(/reading the wrong files/u)).closest('.source-row');
    expect(row, 'the verdict belongs in the source row, not only in a panel').not.toBeNull();
    expect(within(row as HTMLElement).getByText(/412 files collected, no sessions/u)).toBeInTheDocument();
  });

  it('counts the unreadable files without calling a capturing source broken', async () => {
    // A source that is archiving sessions and also collected something
    // unreadable is not misconfigured; it has files a parser cannot read yet.
    unparsed([{ source: 'claude-code', artifacts: 2, diagnostic: null }]);

    render(<MachinesView machines={[machine([source({ sessionCount: 9 })])]} onConnect={vi.fn()} />);

    const row = (await screen.findByText('2 files the archive could not read')).closest('.source-row');
    expect(row, 'the count belongs in the source row').not.toBeNull();
    expect(within(row as HTMLElement).queryByText(/reading the wrong files/u)).not.toBeInTheDocument();
  });

  it('carries the diagnostic the archive gave, rather than a sentence of its own', async () => {
    unparsed([{ source: 'codex', artifacts: 412, diagnostic: 'Collected 412 .jsonl files under ~/.codex/log, none of them sessions' }]);

    render(<MachinesView machines={[machine([source({ id: 'codex', label: 'Codex CLI', sessionCount: 0 })])]} onConnect={vi.fn()} />);

    const panel = await screen.findByRole('region', { name: 'Files the archive could not read' });
    expect(within(panel).getByText('Collected 412 .jsonl files under ~/.codex/log, none of them sessions')).toBeInTheDocument();
  });

  it('shows a tool no machine reports at all, which is the case a source row cannot cover', async () => {
    // The uploading source may not be one of the sources this machine
    // discovered — an upload, or a pattern that discovered nothing. Without the
    // panel there is no row to hang it on and it is invisible.
    unparsed([{ source: 'cursor', artifacts: 30, diagnostic: null }]);

    render(<MachinesView machines={[machine([source()])]} onConnect={vi.fn()} />);

    const panel = await screen.findByRole('region', { name: 'Files the archive could not read' });
    expect(within(panel).getByText('Cursor')).toBeInTheDocument();
    expect(within(panel).getByText('No sessions from this source')).toBeInTheDocument();
  });

  it('says nothing at all when the archive will not answer', async () => {
    // Not "0 unreadable files", not "checking…": a count this page could not
    // obtain is not a reassurance it is entitled to give.
    vi.spyOn(memoarApi, 'listUnparsedArtifacts').mockRejectedValue(new Error('unreachable'));

    render(<MachinesView machines={[machine([source({ sessionCount: 0 })])]} onConnect={vi.fn()} />);

    await screen.findByText('Claude Code');
    expect(screen.queryByRole('region', { name: 'Files the archive could not read' })).not.toBeInTheDocument();
    expect(screen.queryByText(/the archive could not read/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/reading the wrong files/u)).not.toBeInTheDocument();
  });

  it('shows no panel when the archive says nothing is unreadable', async () => {
    unparsed([]);

    render(<MachinesView machines={[machine([source()])]} onConnect={vi.fn()} />);

    await screen.findByText('Claude Code');
    expect(screen.queryByRole('region', { name: 'Files the archive could not read' })).not.toBeInTheDocument();
  });
});
