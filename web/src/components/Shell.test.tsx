import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Shell } from './Shell';
import type { CurrentUser } from '../lib/types';

const USER: CurrentUser = { id: 'u-1', email: 'ada@example.test', displayName: 'Ada Lovelace', hasPassword: true };

function renderShell(onNavigate = vi.fn(), user: CurrentUser | null = USER, onOpenPalette?: () => void) {
  return render(
    <Shell view="timeline" user={user} onNavigate={onNavigate} {...(onOpenPalette ? { onOpenPalette } : {})}>content</Shell>,
  );
}

describe('Shell navigation', () => {
  // Decorative content inside a nav item joins its accessible name. A
  // hardcoded '1' badge on Sharing made the name "Sharing 1", so everything
  // addressing it by its label stopped finding it.
  it.each(['Sessions', 'Search', 'Memory', 'Collections', 'Shared', 'Machines', 'Settings'])(
    'names the %s destination exactly, with no decoration folded in',
    (label) => {
      renderShell();
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    },
  );

  it('marks the current destination', () => {
    renderShell();
    expect(screen.getByRole('link', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Search' })).not.toHaveAttribute('aria-current');
  });

  it('shows the signed-in account rather than a hardcoded name', () => {
    // The sidebar rendered "Frane K." for every user.
    renderShell();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByText('Frane K.')).toBeNull();
  });

  it('puts the address in the account menu, once', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menu')).toHaveTextContent('ada@example.test');
    expect(screen.getByRole('menuitem', { name: 'Switch account' })).toBeInTheDocument();
  });

  it('claims no identity before the account is known', () => {
    renderShell(vi.fn(), null);
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
  });

  it('has no call to action in the sidebar', () => {
    // "Connect a machine" lived here as a primary button. It belongs to Machines.
    renderShell();
    expect(screen.queryByRole('button', { name: /Connect a machine/u })).toBeNull();
  });

  it('navigates to the view behind each destination', async () => {
    const onNavigate = vi.fn();
    renderShell(onNavigate);
    await userEvent.click(screen.getByRole('link', { name: 'Shared' }));
    expect(onNavigate).toHaveBeenCalledWith('sharing');
  });

  it('opens the command palette on Cmd-K and on Ctrl-K', async () => {
    const onOpenPalette = vi.fn();
    renderShell(vi.fn(), USER, onOpenPalette);
    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(onOpenPalette).toHaveBeenCalledTimes(2);
  });

  it('sends / to transcript search', async () => {
    const onNavigate = vi.fn();
    renderShell(onNavigate);
    await userEvent.keyboard('/');
    expect(onNavigate).toHaveBeenCalledWith('search');
  });
});
