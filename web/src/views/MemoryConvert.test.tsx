import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryConvertPanel } from './MemoryConvert';
import { memoarApi } from '../lib/api';
import type { MemoryDocument } from '../lib/types';

function document(overrides: Partial<MemoryDocument> = {}): MemoryDocument {
  return {
    id: 'doc-1',
    scope: 'global',
    machineId: 'machine-1',
    path: '/Users/ada/.claude/CLAUDE.md',
    title: 'CLAUDE.md',
    readers: ['claude-code'],
    contentHash: 'a'.repeat(64),
    capturedAt: '2026-09-18T00:00:00.000Z',
    redactionStatus: 'clear',
    redactionFindings: [],
    ...overrides,
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('porting standing instructions to another tool', () => {
  it('says where the text would land, and what went into it', async () => {
    const convert = vi.spyOn(memoarApi, 'convertMemory').mockResolvedValue({
      source: 'claude-code',
      target: 'codex',
      scope: 'global',
      files: [{
        path: '~/.codex/AGENTS.md',
        size: 175,
        sources: ['/Users/ada/.claude/CLAUDE.md', '/Users/ada/.claude/projects/p/memory/note.md'],
      }],
      report: { documents: 2, concatenated: true },
    });

    render(<MemoryConvertPanel document={document()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show the port' }));

    expect(convert).toHaveBeenCalledWith({ source: 'claude-code', target: 'codex', scope: 'global' });
    // The path is the whole point: the same words, where the other tool reads.
    expect(await screen.findByText('~/.codex/AGENTS.md')).toBeInTheDocument();
    expect(screen.getByText(/joined into one with a note saying where each part came from/u)).toBeInTheDocument();
    expect(screen.getByText(/\/Users\/ada\/\.claude\/projects\/p\/memory\/note\.md/u)).toBeInTheDocument();
  });

  /*
    Cursor reads nothing from a `.cursor/rules/*.mdc` without frontmatter, and
    inventing frontmatter is not a mechanical port. Offering it would be a
    control that produces a file Cursor silently ignores.
  */
  it('does not offer a target the archive would refuse to write', () => {
    render(<MemoryConvertPanel document={document({ readers: ['claude-code', 'cursor'] })} />);

    const to = screen.getByRole('combobox', { name: 'Convert to' });
    expect(within(to).queryByRole('option', { name: 'cursor' })).toBeNull();
    expect(within(to).getByRole('option', { name: 'codex' })).toBeInTheDocument();
    // As a source it is offered, because memoar does capture Cursor's rules.
    const from = screen.getByRole('combobox', { name: 'Convert from' });
    expect(within(from).getByRole('option', { name: 'cursor' })).toBeInTheDocument();
  });

  it('shows the refusal when the file has not been reviewed', async () => {
    vi.spyOn(memoarApi, 'convertMemory').mockRejectedValue(
      new Error('The secret scanner found something in this memory file. A person has to review it before its text can be read outside the archive.'),
    );

    render(<MemoryConvertPanel document={document({ redactionStatus: 'findings', redactionFindings: ['api_key'] })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show the port' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/A person has to review it/u);
    expect(screen.queryByText('~/.codex/AGENTS.md'), 'nothing is shown that was refused').toBeNull();
  });

  it('carries the workspace for a project file, so one repository does not receive another one', async () => {
    const convert = vi.spyOn(memoarApi, 'convertMemory').mockResolvedValue({
      source: 'claude-code',
      target: 'codex',
      scope: 'project',
      workspacePath: '/workspace/memoar',
      files: [{ path: './AGENTS.md', size: 20, sources: ['/workspace/memoar/CLAUDE.md'] }],
      report: { documents: 1, concatenated: false },
    });

    render(<MemoryConvertPanel document={document({ scope: 'project', workspacePath: '/workspace/memoar' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show the port' }));

    expect(convert).toHaveBeenCalledWith({
      source: 'claude-code',
      target: 'codex',
      scope: 'project',
      workspacePath: '/workspace/memoar',
    });
    expect(await screen.findByText('./AGENTS.md')).toBeInTheDocument();
  });
});
