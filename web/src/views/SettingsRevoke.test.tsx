import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from './Settings';
import { memoarApi } from '../lib/api';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(memoarApi, 'getSettings').mockResolvedValue({
    redaction: { secretScan: true, pathScan: true, emailScan: false, customPatterns: [] },
    retention: { policy: 'indefinite', exemptCollected: true },
    updatedAt: null,
  });
  vi.spyOn(memoarApi, 'getDistillationSettings').mockResolvedValue({
    provider: 'none', model: null, enabled: false, keySet: false, keyHint: null,
    monthlyBudgetCents: 0, monthlySpentCents: 0, remainingCents: 0,
    budgetWindowStartedAt: '2026-09-01T00:00:00.000Z',
  });
  vi.spyOn(memoarApi, 'getMcpStatus').mockResolvedValue({
    available: true, contractVersion: '0.3.0', tools: ['search_sessions'],
  });
});

/**
 * A key you believe you revoked and have not is the worst way for this
 * particular failure to be silent.
 *
 * The failure was written to the state the create-key dialog renders, and that
 * dialog is closed while you are revoking from the list — so the message was
 * set and shown to nobody. The row stopped being busy and the key stayed.
 */
describe('revoking an API key', () => {
  it('says so when the archive refuses', async () => {
    vi.spyOn(memoarApi, 'revokeApiKey').mockRejectedValue(new Error('Key is already revoked'));
    render(
      <SettingsView
        apiKeys={[{ id: 'k-1', name: 'Codex MCP', prefix: 'memoar_abc', scopes: ['mcp:use'], createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null }]}
        mcpEndpoint="https://app.dev.memoar.test/mcp"
        user={null}
        onCreateKey={vi.fn()}
        onKeyRevoked={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByLabelText('Revoke Codex MCP'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Key is already revoked'),
    );
  });

  it('says nothing when it worked', async () => {
    const revoked = vi.fn();
    vi.spyOn(memoarApi, 'revokeApiKey').mockResolvedValue(undefined);
    render(
      <SettingsView
        apiKeys={[{ id: 'k-1', name: 'Codex MCP', prefix: 'memoar_abc', scopes: ['mcp:use'], createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null }]}
        mcpEndpoint="https://app.dev.memoar.test/mcp"
        user={null}
        onCreateKey={vi.fn()}
        onKeyRevoked={revoked}
      />,
    );
    await userEvent.click(screen.getByLabelText('Revoke Codex MCP'));
    await waitFor(() => expect(revoked).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
