import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../lib/types';
import { SearchResults } from './search/SearchResults';

function session(id: string, title: string): SessionSummary {
  return {
    id, title, summary: '', source: 'codex', sourceLabel: 'Codex CLI', workspace: '/w',
    createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:00:00.000Z', turnCount: 1, tokenCount: 0, redactionStatus: 'clear',
  };
}

describe('moving through a list from the keyboard', () => {
  it('moves with j and k, and opens with Enter', async () => {
    const onOpen = vi.fn();
    render(<SearchResults items={[session('a', 'First'), session('b', 'Second')]} query="" onOpen={onOpen} />);

    await userEvent.keyboard('j');
    await userEvent.keyboard('j');
    await vi.waitFor(() => expect(screen.getByRole('link', { name: /Second/u })).toHaveFocus());
    await userEvent.keyboard('k');
    await vi.waitFor(() => expect(screen.getByRole('link', { name: /First/u })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('says one turn, not one turns', () => {
    render(<SearchResults items={[session('a', 'First')]} query="" onOpen={vi.fn()} />);
    expect(screen.getByText('1 turn')).toBeInTheDocument();
  });
});
