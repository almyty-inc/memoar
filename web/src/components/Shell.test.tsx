import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Shell } from './Shell';

function renderShell(onNavigate = vi.fn()) {
  return render(<Shell view="timeline" mode="connected" onNavigate={onNavigate}>content</Shell>);
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

  it('navigates to the view behind each destination', () => {
    const onNavigate = vi.fn();
    renderShell(onNavigate);
    screen.getAllByRole('button', { name: 'Sharing' })[0]!.click();
    expect(onNavigate).toHaveBeenCalledWith('sharing');
  });
});
