import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryView } from './Memory';
import { memoarApi } from '../lib/api';
import type { MemoryDocument, MemoryRevision } from '../lib/types';

/** A global file has no workspace at all, rather than an undefined one. */
function document(overrides: Partial<MemoryDocument> = {}, workspacePath: string | null = '/workspace/memoar'): MemoryDocument {
  return {
    id: 'doc-1',
    scope: 'project',
    machineId: 'machine-1',
    ...(workspacePath === null ? {} : { workspacePath }),
    path: '/workspace/memoar/AGENTS.md',
    title: 'AGENTS.md',
    readers: ['codex', 'cursor', 'zed'],
    contentHash: 'a'.repeat(64),
    capturedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function revision(id: string, text: string, capturedAt: string): MemoryRevision {
  return { id, documentId: 'doc-1', contentHash: id.repeat(8), text, size: text.length, capturedAt };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('agent memory', () => {
  it('groups what applies everywhere apart from what applies to one project', async () => {
    vi.spyOn(memoarApi, 'listMemory').mockResolvedValue({
      items: [
        document(),
        document({ id: 'doc-2', scope: 'global', path: '/Users/ada/.claude/CLAUDE.md', title: 'CLAUDE.md', readers: ['claude-code'] }, null),
      ],
    });

    render(<MemoryView />);

    expect(await screen.findByText('Everywhere on this account')).toBeInTheDocument();
    expect(screen.getByText('/workspace/memoar')).toBeInTheDocument();
    // A file is named by the tools that read it, not the one that wrote it.
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('cursor')).toBeInTheDocument();
  });

  it('shows the current text, and lets an older version be read', async () => {
    // Keeping the history is the point of storing these at all: what the agent
    // was told last month explains a session from last month.
    vi.spyOn(memoarApi, 'listMemory').mockResolvedValue({ items: [document()] });
    vi.spyOn(memoarApi, 'getMemory').mockResolvedValue({
      document: document(),
      revisions: [
        revision('r2', 'Be terse. Never guess.', '2026-08-20T00:00:00.000Z'),
        revision('r1', 'Be terse.', '2026-08-19T00:00:00.000Z'),
      ],
    });

    render(<MemoryView />);
    await userEvent.click(await screen.findByText('AGENTS.md'));

    expect(await screen.findByText('Be terse. Never guess.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Current/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /19 Aug 2026|Aug 19, 2026|2026/ }));
    expect(await screen.findByText('Be terse.')).toBeInTheDocument();
  });

  it('says what to do when nothing has been captured, rather than showing an empty page', async () => {
    vi.spyOn(memoarApi, 'listMemory').mockResolvedValue({ items: [] });

    render(<MemoryView />);

    expect(await screen.findByText('No memory files captured yet')).toBeInTheDocument();
  });

  it('reports a failure to load instead of pretending there is nothing', async () => {
    vi.spyOn(memoarApi, 'listMemory').mockRejectedValue(new Error('Archive unreachable'));

    render(<MemoryView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Archive unreachable');
  });

  it('removes a file and reloads the list', async () => {
    const list = vi.spyOn(memoarApi, 'listMemory')
      .mockResolvedValueOnce({ items: [document()] })
      .mockResolvedValueOnce({ items: [] });
    const remove = vi.spyOn(memoarApi, 'deleteMemory').mockResolvedValue(undefined);

    render(<MemoryView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove /workspace/memoar/AGENTS.md' }));

    expect(remove).toHaveBeenCalledWith('doc-1');
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No memory files captured yet')).toBeInTheDocument();
  });
});
