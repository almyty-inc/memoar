import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { memoarApi } from './lib/api';
import type { DashboardState } from './lib/types';

/**
 * A browser token lives an hour and is never refreshed.
 *
 * Nothing said so. The first sign of it was a 401 on the next request, which
 * cleared the session, dispatched `memoar:unauthorized` and swapped the screen
 * for the sign-in form — losing whatever was on the one being replaced, and
 * landing on the timeline afterwards rather than back where the reader was.
 */
const EMPTY: DashboardState = {
  timeline: [], archivedSessions: 0, collections: [], grants: [], transfers: [], machines: [], apiKeys: [],
};

describe('a sign-in that is about to lapse', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/timeline');
    vi.spyOn(memoarApi, 'loadDashboard').mockResolvedValue(EMPTY);
    vi.spyOn(memoarApi, 'authMethods').mockResolvedValue({ password: true, signup: 'open', oauth: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    memoarApi.clearSession();
  });

  it('says so while there is still time to save', async () => {
    memoarApi.setAccessToken('token', new Date(Date.now() + 2 * 60 * 1000).toISOString());

    render(<App />);

    expect(await screen.findByText('This sign-in expires in 2 minutes.')).toBeInTheDocument();
  });

  it('says nothing for a session with most of its hour left', async () => {
    memoarApi.setAccessToken('token', new Date(Date.now() + 55 * 60 * 1000).toISOString());

    render(<App />);

    await screen.findByRole('heading', { name: 'Pick up where you left off.' });
    expect(screen.queryByText(/This sign-in expires/u)).not.toBeInTheDocument();
  });

  it('brings the reader back to the screen they were taken off', async () => {
    window.history.replaceState(null, '', '/collections');
    render(<App />);
    await screen.findByRole('heading', { name: 'Collections' });

    // What the 401 handler in the client does, from the middle of the work.
    act(() => { window.dispatchEvent(new CustomEvent('memoar:unauthorized')); });
    expect(await screen.findByRole('heading', { name: 'Open your archive.' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'ada@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /Sign in/u }));

    await waitFor(() => { expect(window.location.pathname).toBe('/collections'); });
    expect(screen.getByRole('heading', { name: 'Collections' })).toBeInTheDocument();
  });
});
