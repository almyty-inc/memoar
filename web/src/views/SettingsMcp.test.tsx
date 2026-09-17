import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from './Settings';
import { memoarApi } from '../lib/api';

let settingsLoaded: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  settingsLoaded = vi.spyOn(memoarApi, 'getSettings').mockResolvedValue({
    redaction: { secretScan: true, pathScan: true, emailScan: false, customPatterns: [] },
    retention: { policy: 'indefinite', exemptCollected: true },
    updatedAt: null,
  });
  vi.spyOn(memoarApi, 'getDistillationSettings').mockResolvedValue({
    provider: 'none', model: null, enabled: false, keySet: false, keyHint: null,
    monthlyBudgetCents: 0, monthlySpentCents: 0, remainingCents: 0,
    budgetWindowStartedAt: '2026-09-01T00:00:00.000Z',
  });

});

function renderSettings() {
  return render(
    <SettingsView
      apiKeys={[]}
      mcpEndpoint="https://app.dev.memoar.test/mcp"
      user={null}
      onCreateKey={vi.fn()}
      onKeyRevoked={vi.fn()}
    />,
  );
}

describe('the remote MCP section', () => {
  it('claims no availability it has not measured', async () => {
    /*
      This carried <Badge className="status-active"><span /> Available</Badge>:
      a live green dot, no condition behind it, beside an endpoint string the
      browser never contacts. It read "Available" on a deployment that serves
      no MCP at all. The same defect was removed twice before — the topbar's
      literal "Connected", and the client list that marked whichever row came
      first as "Connected 8m ago".
    */
    const { container } = renderSettings();
    await waitFor(() => expect(settingsLoaded).toHaveBeenCalled());

    expect(screen.queryByText(/Available/u)).not.toBeInTheDocument();
    expect(container.querySelector('.mcp-section .status-active')).toBeNull();
  });

  it('still says what it does know: the endpoint, and how to add it', async () => {
    renderSettings();
    await waitFor(() => expect(settingsLoaded).toHaveBeenCalled());

    expect(screen.getByText('https://app.dev.memoar.test/mcp')).toBeInTheDocument();
    expect(screen.getByText(/claude mcp add --transport http memoar/u)).toBeInTheDocument();
  });
});
