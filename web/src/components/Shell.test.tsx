import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Shell } from './Shell';
import type { CurrentUser, Machine } from '../lib/types';

const USER: CurrentUser = { id: 'u-1', email: 'ada@example.test', displayName: 'Ada Lovelace' };

let machineCount = 0;

function machine(sources: Array<{ enabled: boolean; sessionCount?: number }>): Machine {
  machineCount += 1;
  return {
    id: `m-${machineCount}`, name: 'workstation', platform: 'darwin', status: 'online', lastSeenAt: null, agentVersion: '0.2.0',
    sources: sources.map((source, index) => ({
      id: `s-${index}`, label: `source-${index}`, enabled: source.enabled,
      state: source.enabled ? 'synced' : 'disabled', sessionCount: source.sessionCount ?? 0, lastSyncAt: null,
    })),
  };
}

function renderShell(onNavigate = vi.fn(), user: CurrentUser | null = USER, machines: Machine[] = []) {
  return render(<Shell view="timeline" mode="connected" user={user} machines={machines} onNavigate={onNavigate}>content</Shell>);
}

describe('Shell navigation', () => {
  // Decorative content inside a nav button joins its accessible name. A
  // hardcoded '1' badge on Sharing made the name "Sharing 1", so every caller
  // addressing the button by its label — assistive tech included — stopped
  // finding it, and the app looked like it had no Sharing nav at all.
  it.each(['Timeline', 'Search', 'Import', 'Collections', 'Sharing', 'Machines & sources', 'Settings'])(
    'names the %s destination exactly, with no decoration folded in',
    (label) => {
      renderShell();
      expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThan(0);
    },
  );

  it('does not claim pending items it cannot count', () => {
    const { container } = renderShell();
    expect(container.querySelectorAll('.nav-badge')).toHaveLength(0);
  });

  it('shows the signed-in account rather than a hardcoded name', () => {
    // The sidebar rendered "Frane K." and the initials "FK" for every user.
    renderShell();
    expect(screen.getByText('Ada Lovelace')).toBeDefined();
    expect(screen.getByText('ada@example.test')).toBeDefined();
    expect(screen.getByText('AL')).toBeDefined();
    expect(screen.queryByText('Frane K.')).toBeNull();
    expect(screen.queryByText('FK')).toBeNull();
  });

  it('claims no identity before the account is known', () => {
    renderShell(vi.fn(), null);
    expect(screen.getByText('Not signed in')).toBeDefined();
  });

  it('measures setup progress instead of drawing it', () => {
    // This read "2 of 3 sources connected" no matter how many existed, then
    // "80 of 80 sources connected" once it counted source entries — true, and
    // useless. Underneath it a progress bar was fixed at 66% in the stylesheet,
    // so it showed the same two-thirds whether nothing or everything had been
    // captured. What matters during setup is whether a machine is archiving.
    renderShell(vi.fn(), USER, [
      machine([{ enabled: true, sessionCount: 4 }]),
      machine([{ enabled: true, sessionCount: 0 }]),
    ]);

    expect(screen.getByText('1 of 2 machines are archiving')).toBeDefined();
    expect(document.querySelector('.mini-progress span')).toHaveStyle({ width: '50%' });
  });

  it('says so plainly when nothing is connected yet', () => {
    renderShell(vi.fn(), USER, []);
    expect(screen.getByText('No machine connected yet')).toBeDefined();
    expect(document.querySelector('.mini-progress span')).toHaveStyle({ width: '0%' });
  });

  it('navigates to the view behind each destination', () => {
    const onNavigate = vi.fn();
    renderShell(onNavigate);
    screen.getAllByRole('button', { name: 'Sharing' })[0]!.click();
    expect(onNavigate).toHaveBeenCalledWith('sharing');
  });
});
