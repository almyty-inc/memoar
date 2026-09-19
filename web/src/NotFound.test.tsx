import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { memoarApi } from './lib/api';

const EMPTY = {
  timeline: [], archivedSessions: 0, collections: [], grants: [],
  transfers: [], machines: [], apiKeys: [],
};

describe('an address with no screen behind it', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.spyOn(memoarApi, 'loadDashboard').mockResolvedValue(EMPTY);
    vi.spyOn(memoarApi, 'currentUser').mockRejectedValue(new Error('no identity'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('says so, instead of quietly rendering the timeline', async () => {
    /*
      routeForPath returned null for anything it did not recognise and both
      callers fell back to { view: 'timeline' }, so a typo'd or retired link
      rendered the archive under an address that does not name it — a page
      saying one thing and an address bar saying another.
    */
    window.history.replaceState(null, '', '/timelnie');

    render(<App />);

    expect(await screen.findByRole('heading', { name: /No screen lives at this address/u })).toBeInTheDocument();
    expect(screen.getByText('/timelnie')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pick up where you left off.' })).not.toBeInTheDocument();
    // And the address is left alone, so it can be corrected or reported.
    expect(window.location.pathname).toBe('/timelnie');
  });

  it('still renders a real address normally', async () => {
    window.history.replaceState(null, '', '/timeline');

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Pick up where you left off.' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /No screen lives at this address/u })).not.toBeInTheDocument();
  });
});
