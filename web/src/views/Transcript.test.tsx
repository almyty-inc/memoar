import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionDetailData, SessionTurn } from '../lib/types';
import { Transcript } from './session-detail/Transcript';

function detail(turns: SessionTurn[]): SessionDetailData {
  return {
    session: {
      id: 's-1', title: 'Fix it', summary: '', source: 'claude-code', sourceLabel: 'Claude Code', workspace: '/w',
      createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:30:00.000Z', turnCount: turns.length, tokenCount: 0, redactionStatus: 'clear',
    },
    turns,
    provenance: [],
    tokenTotals: { input: 0, output: 0, cacheRead: 0 },
  };
}

const at = '2026-09-01T09:00:00.000Z';

describe('a transcript', () => {
  it('draws a shell command as a terminal with its output folded in', () => {
    render(<Transcript showThinking={false} setShowThinking={vi.fn()} detail={detail([
      { id: 't1', ordinal: 1, parentId: null, role: 'assistant', createdAt: at, blocks: [
        { id: 'b1', kind: 'tool_call', name: 'Bash', callId: 'c1', data: { command: 'npm test' } },
      ] },
      { id: 't2', ordinal: 2, parentId: 't1', role: 'tool', createdAt: at, blocks: [
        { id: 'b2', kind: 'tool_result', callId: 'c1', text: '4 passed', status: 'success' },
      ] },
    ])} />);

    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('4 passed')).toBeInTheDocument();
    // The result is drawn once, inside the call, not again as its own turn.
    expect(screen.queryByText('Tool')).not.toBeInTheDocument();
  });

  it('draws a file edit as a diff with added and removed lines', () => {
    render(<Transcript showThinking={false} setShowThinking={vi.fn()} detail={detail([
      { id: 't1', ordinal: 1, parentId: null, role: 'assistant', createdAt: at, blocks: [
        { id: 'b1', kind: 'tool_call', name: 'Edit', callId: 'c1', data: { file_path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' } },
      ] },
    ])} />);

    const diff = screen.getByRole('table', { name: 'Diff for src/a.ts' });
    expect(diff.querySelectorAll('.diff-add')).toHaveLength(1);
    expect(diff.querySelectorAll('.diff-remove')).toHaveLength(1);
  });

  it('collapses a file read to its path and length', () => {
    render(<Transcript showThinking={false} setShowThinking={vi.fn()} detail={detail([
      { id: 't1', ordinal: 1, parentId: null, role: 'assistant', createdAt: at, blocks: [
        { id: 'b1', kind: 'tool_call', name: 'Read', callId: 'c1', data: { file_path: 'src/a.ts' } },
        { id: 'b2', kind: 'tool_result', callId: 'c1', text: 'one\ntwo\nthree', status: 'success' },
      ] },
    ])} />);

    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('3 lines')).toBeInTheDocument();
  });

  it('highlights fenced code in a message', () => {
    const { container } = render(<Transcript showThinking={false} setShowThinking={vi.fn()} detail={detail([
      { id: 't1', ordinal: 1, parentId: null, role: 'assistant', createdAt: at, blocks: [
        { id: 'b1', kind: 'text', text: 'Run this:\n\n```ts\nconst answer: number = 42;\n```' },
      ] },
    ])} />);

    expect(container.querySelector('.hljs-keyword')).toHaveTextContent('const');
  });
});
