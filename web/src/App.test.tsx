import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { MemoarApiClient } from './lib/api';

describe('Memoar archive app', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '#/timeline');
    window.sessionStorage.clear();
  });

  it('renders a dark-default timeline with a usable demo archive', async () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Pick up where you left off.' })).toBeInTheDocument();
    expect(screen.getByText('Demo archive')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Checking archive connection')).not.toBeInTheDocument());
  });

  it('searches as you type and opens the canonical session detail', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getAllByRole('button', { name: 'Search' })[0]!);
    const search = screen.getByRole('searchbox', { name: 'Search sessions' });
    await user.clear(search);
    await user.type(search, 'parent reference');

    const resultTitle = await screen.findByRole('heading', { name: 'Fix session parser branch recovery' });
    const resultButton = resultTitle.closest('button');
    expect(resultButton).not.toBeNull();
    await user.click(resultButton!);

    expect(await screen.findByText(/The normalizer now resolves/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByText('Raw artifact preserved and content-addressed.')).toBeInTheDocument();
  });

  it('exposes API key and MCP controls', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('heading', { name: 'API keys' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Remote MCP' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByRole('dialog', { name: 'Create API key' })).toBeInTheDocument();
  });

  it('falls back to typed local data when no API URL is configured', async () => {
    const client = new MemoarApiClient('');
    const dashboard = await client.loadDashboard();
    const results = await client.search('redaction');

    expect(dashboard.mode).toBe('demo');
    expect(dashboard.timeline.flatMap((group) => group.sessions).length).toBeGreaterThan(5);
    expect(results.items.some((session) => session.title.includes('redaction'))).toBe(true);
    expect(results.meta.realizedMode).toBe('hybrid');
  });
  it('persists an OAuth callback session and scrubs it from the URL', () => {
    const client = new MemoarApiClient('http://memoar.test/v1');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    window.history.replaceState(null, '', `/#access_token=callback-token&expires_at=${encodeURIComponent(expiresAt)}`);

    expect(client.consumeOAuthCallback()).toBe(true);
    expect(client.authenticated).toBe(true);
    expect(window.location.hash).toBe('#/timeline');
    expect(window.location.href).not.toContain('callback-token');
  });

});
