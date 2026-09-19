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
    redactionStatus: 'clear',
    redactionFindings: [],
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

  /*
    Redaction review, on the screen where the file can actually be read.

    A memory file is where somebody writes a staging key, and nobody re-reads
    one before it goes out. The archive refuses to serve a flagged file to an
    agent until a person has looked — so the person needs somewhere to look.
  */
  it('says what the scanner found and lets a person review it', async () => {
    const flagged = document({ redactionStatus: 'findings', redactionFindings: ['api_key', 'api_key', 'email'] });
    vi.spyOn(memoarApi, 'listMemory').mockResolvedValue({ items: [flagged] });
    vi.spyOn(memoarApi, 'getMemory').mockResolvedValue({
      document: flagged,
      revisions: [revision('r1', 'The staging key is sk_live_0123456789abcdefghij.', '2026-08-20T00:00:00.000Z')],
    });
    const review = vi.spyOn(memoarApi, 'reviewMemory')
      .mockResolvedValue(document({ redactionStatus: 'reviewed', redactionFindings: ['api_key', 'api_key', 'email'] }));

    render(<MemoryView />);
    // The status is on the file in the list, before it has been opened.
    expect(await screen.findByText('Needs review')).toBeInTheDocument();

    await userEvent.click(screen.getByText('AGENTS.md'));
    expect(await screen.findByText('The scanner matched 3 things in this file.')).toBeInTheDocument();
    expect(screen.getByText('API key ×2')).toBeInTheDocument();
    expect(screen.getByText('email address')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    // The version reviewed is the version read, not whatever the file says when
    // the request lands.
    expect(review).toHaveBeenCalledWith('doc-1', 'a'.repeat(64));
    // Both where the file is listed and where it was read: one document, one status.
    expect(await screen.findAllByText('Reviewed')).toHaveLength(2);
    expect(screen.queryByText('Needs review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
  });

  it('leaves the status where it was when the review is refused', async () => {
    // Showing "Reviewed" on the strength of having asked would be the page
    // asserting something nobody measured.
    const flagged = document({ redactionStatus: 'findings', redactionFindings: ['api_key'] });
    vi.spyOn(memoarApi, 'listMemory').mockResolvedValue({ items: [flagged] });
    vi.spyOn(memoarApi, 'getMemory').mockResolvedValue({
      document: flagged,
      revisions: [revision('r1', 'sk_live_0123456789abcdefghij', '2026-08-20T00:00:00.000Z')],
    });
    vi.spyOn(memoarApi, 'reviewMemory').mockRejectedValue(new Error('This file was captured again while it was being reviewed.'));

    render(<MemoryView />);
    await userEvent.click(await screen.findByText('AGENTS.md'));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('captured again');
    expect(screen.queryByText('Reviewed')).not.toBeInTheDocument();
    expect(screen.getAllByText('Needs review').length).toBeGreaterThan(0);
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
