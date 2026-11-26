import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { fuzzyScore, rank, type Command } from './command-search';

function command(id: string, label: string, extra: Partial<Command> = {}): Command {
  return { id, group: 'Go to', label: () => label, run: vi.fn(), ...extra };
}

describe('fuzzy matching', () => {
  it('finds letters at word starts', () => {
    expect(fuzzyScore('ftc', 'Fix timeline cursor')).not.toBeNull();
  });

  it('rejects letters scattered across unrelated words', () => {
    // "dark" used to find "Debug websocket reconnect loop".
    expect(fuzzyScore('dark', 'Debug websocket reconnect loop')).toBeNull();
  });

  it('ranks a whole-word match above a scattered one', () => {
    const ranked = rank([command('a', 'Debug cache'), command('b', 'Cursor fix')], 'cursor');
    expect(ranked.map((entry) => entry.id)).toEqual(['b']);
  });

  it('keeps commands that need a query out of the empty list', () => {
    const ranked = rank([command('a', 'Sessions'), command('b', 'Use the dark theme', { needsQuery: true })], '');
    expect(ranked.map((entry) => entry.id)).toEqual(['a']);
  });
});

describe('the command palette', () => {
  it('runs the highlighted command on Enter and closes', async () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open commands={[command('a', 'Sessions'), command('b', 'Settings', { run })]} onClose={onClose} />);

    await userEvent.type(screen.getByRole('combobox', { name: 'Command' }), 'sett');
    expect(screen.getByRole('option', { name: /Settings/u })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');

    expect(onClose).toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('sett');
  });

  it('moves with the arrow keys', async () => {
    render(<CommandPalette open commands={[command('a', 'Sessions'), command('b', 'Search')]} onClose={vi.fn()} />);
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<CommandPalette open commands={[command('a', 'Sessions')]} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
